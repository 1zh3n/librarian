use std::{collections::BTreeMap, fs, path::Path as DiskPath, sync::Arc};

use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

use super::{
    auth::Account,
    contract::ApiError,
    delivery,
    documents::{is_document_path, run, state, DocumentService},
    image_policy::{self, ConflictPolicy},
    imports, mutations,
};

const MAX_IMAGE_BYTES: usize = mutations::MAX_ASSET_BYTES;
const MAX_MULTIPART_BYTES: usize = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/workspaces/{workspace}/assets", post(upload))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_MULTIPART_BYTES))
}

pub(super) struct ImageUpload {
    pub operation_id: String,
    pub target_directory: String,
    pub file_name: String,
    pub conflict_policy: ConflictPolicy,
    pub base_revision: Option<String>,
    pub bytes: Vec<u8>,
}

pub(super) fn upload_image(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    input: ImageUpload,
) -> Result<Value, ApiError> {
    if Uuid::parse_str(&input.operation_id)
        .ok()
        .is_none_or(|uuid| uuid.to_string() != input.operation_id)
    {
        return Err(ApiError::invalid("A canonical operationId is required"));
    }
    let (instance, _) = service.scope(account, ws, true)?;
    let state = state(&instance)?;
    let file_name = image_policy::validate_file_name(&input.file_name)?;
    let target_directory = image_policy::validate_directory(&input.target_directory)?;
    image_policy::inspect(&file_name, &input.bytes)?;

    let path = choose_path(
        state,
        &target_directory,
        &file_name,
        input.conflict_policy,
        input.base_revision.as_deref(),
    )?;
    let digest = sha256_hex(
        &serde_json::to_vec(&(
            ws,
            &input.operation_id,
            &target_directory,
            &file_name,
            input.conflict_policy == ConflictPolicy::Reject,
            input.base_revision.as_deref(),
            sha256_hex(&input.bytes),
        ))
        .map_err(ApiError::internal)?,
    );
    let mut files = BTreeMap::new();
    files.insert(path.clone(), input.bytes);
    let updates = input
        .base_revision
        .into_iter()
        .map(|revision| (path.clone(), revision))
        .collect::<BTreeMap<_, _>>();
    let receipt = imports::import_files(
        service,
        account,
        ws,
        imports::ImportFiles {
            operation_id: input.operation_id,
            dir: String::new(),
            files,
            updates,
            digest,
        },
    )?;
    let asset = receipt.assets.first().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "operation_id_reused",
            "Operation ID is already bound to another request",
        )
    })?;
    let link = service.reader_links.asset(ws, &asset.path);
    let mut result = json!({
        "path": asset.path,
        "assetPath": link.asset_path,
        "assetUrl": link.asset_url,
        "revision": asset.revision,
        "contentType": asset.content_type,
        "width": asset.width,
        "height": asset.height,
        "size": asset.size,
        "operationId": receipt.receipt.operation_id,
        "commitId": receipt.receipt.commit_id,
    });
    if let Some(error) = link.asset_url_error {
        result["assetUrlError"] = json!(error);
    }
    Ok(result)
}

fn choose_path(
    state: &crate::state::ServerState,
    directory: &str,
    file_name: &str,
    policy: ConflictPolicy,
    base_revision: Option<&str>,
) -> Result<String, ApiError> {
    let path = join_path(directory, file_name);
    if let Some(base_revision) = base_revision {
        let root = DiskPath::new(&state.space_folder_path);
        let Some(current) = mutations::current_bytes(root, state.space.as_ref(), &path)? else {
            return Err(ApiError::conflict_with(
                "asset_revision_conflict",
                "The image to replace no longer exists",
                None,
            ));
        };
        let actual = sha256_hex(&current);
        if actual != base_revision {
            return Err(ApiError::conflict_with(
                "asset_revision_conflict",
                "The image revision changed",
                Some(actual),
            ));
        }
        return Ok(path);
    }
    if policy == ConflictPolicy::Reject && asset_exists(state, &path)? {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "asset_path_exists",
            "An asset already uses this path",
        ));
    }
    if !asset_exists(state, &path)? {
        return Ok(path);
    }
    let (stem, extension) = split_name(file_name);
    for number in 2..=10_000 {
        let candidate = join_path(directory, &format!("{stem}-{number}.{extension}"));
        if !asset_exists(state, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(ApiError::new(
        StatusCode::CONFLICT,
        "asset_path_exists",
        "No unique image name is available",
    ))
}

fn split_name(file_name: &str) -> (&str, &str) {
    file_name
        .rsplit_once('.')
        .map_or((file_name, ""), |(stem, extension)| (stem, extension))
}

fn join_path(directory: &str, file_name: &str) -> String {
    if directory.is_empty() {
        file_name.to_owned()
    } else {
        format!("{directory}/{file_name}")
    }
}

fn asset_exists(state: &crate::state::ServerState, path: &str) -> Result<bool, ApiError> {
    if state.space.get_file_meta(path).is_ok() {
        return Ok(true);
    }
    let root = DiskPath::new(&state.space_folder_path);
    match fs::symlink_metadata(root.join(path)) {
        Ok(_) => return Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ApiError::internal(error)),
    }
    let lower = path.to_lowercase();
    Ok(state
        .space
        .fetch_file_list()?
        .iter()
        .any(|entry| entry.name.to_lowercase() == lower))
}

pub(super) fn read_asset(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    path: &str,
) -> Result<Value, ApiError> {
    if !delivery::included_path(path) || path.to_ascii_lowercase().ends_with(".md") {
        return Err(ApiError::not_found());
    }
    let (instance, _) = service.scope(account, ws, false)?;
    let state = state(&instance)?;
    let _read = crate::product::documents::product_read(state)?;
    let root = DiskPath::new(&state.space_folder_path);
    let bytes = mutations::current_bytes(root, state.space.as_ref(), path)?
        .ok_or_else(ApiError::not_found)?;
    let info = image_policy::inspect(path, &bytes).ok();
    let revision = sha256_hex(&bytes);
    let link = service.reader_links.asset(ws, path);
    let content_type = info
        .map(|info| info.kind.content_type())
        .unwrap_or_else(|| content_type_for(path));
    let inline = info.is_some() && bytes.len() <= MAX_INLINE_IMAGE_BYTES;
    let mut result = json!({
        "path": path,
        "assetPath": link.asset_path,
        "assetUrl": link.asset_url,
        "revision": revision,
        "contentType": content_type,
        "size": bytes.len(),
        "isImage": info.is_some(),
        "inline": inline,
    });
    if let Some(error) = link.asset_url_error {
        result["assetUrlError"] = json!(error);
    }
    if inline {
        result["imageBase64"] = json!(STANDARD.encode(&bytes));
        result["mimeType"] = json!(content_type);
    }
    Ok(result)
}

pub(super) fn list_assets(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    directory: &str,
    after: Option<&str>,
    limit: Option<usize>,
) -> Result<Value, ApiError> {
    let directory = image_policy::validate_directory(directory)?;
    let (instance, _) = service.scope(account, ws, false)?;
    let state = state(&instance)?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    let mut paths = state
        .space
        .fetch_file_list()?
        .into_iter()
        .map(|entry| entry.name)
        .filter(|path| {
            !is_document_path(path)
                && !path.starts_with('.')
                && delivery::included_path(path)
                && (prefix.is_empty() || path.starts_with(&prefix))
                && after.is_none_or(|after| path.as_str() > after)
        })
        .collect::<Vec<_>>();
    paths.sort();
    let has_more = paths.len() > limit;
    paths.truncate(limit);
    let assets = paths
        .into_iter()
        .map(|path| {
            let link = service.reader_links.asset(ws, &path);
            let info = state.space.get_file_meta(&path).ok().map(|meta| {
                let is_image = image_policy::is_image_extension(&path);
                (meta.size, is_image, content_type_for(&path))
            });
            let (size, is_image, content_type) = info.unwrap_or((
                0,
                image_policy::is_image_extension(&path),
                content_type_for(&path),
            ));
            json!({
                "path": path,
                "assetPath": link.asset_path,
                "assetUrl": link.asset_url,
                "size": size,
                "contentType": content_type,
                "isImage": is_image,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "assets": assets,
        "hasMore": has_more,
    }))
}

fn content_type_for(path: &str) -> &'static str {
    match DiskPath::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

async fn upload(
    State(service): State<Arc<DocumentService>>,
    Path(ws): Path<String>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let mut operation_id = None;
    let mut target_directory = None;
    let mut file_name = None;
    let mut conflict_policy = None;
    let mut base_revision = None;
    let mut bytes = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "file" => {
                let value = field.bytes().await.map_err(multipart_error)?;
                if value.len() > MAX_IMAGE_BYTES {
                    return Err(image_policy::asset_too_large());
                }
                bytes = Some(value.to_vec());
            }
            "operationId" => operation_id = Some(field.text().await.map_err(multipart_error)?),
            "targetDirectory" => {
                target_directory = Some(field.text().await.map_err(multipart_error)?)
            }
            "fileName" => file_name = Some(field.text().await.map_err(multipart_error)?),
            "conflictPolicy" => {
                conflict_policy = match field.text().await.map_err(multipart_error)?.as_str() {
                    "rename" => Some(ConflictPolicy::Rename),
                    "reject" => Some(ConflictPolicy::Reject),
                    _ => return Err(ApiError::invalid("Unknown image conflict policy")),
                }
            }
            "baseRevision" => base_revision = Some(field.text().await.map_err(multipart_error)?),
            _ => {
                let _ = field.bytes().await;
            }
        }
    }
    let operation_id = operation_id
        .filter(|value| Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value.as_str()))
        .ok_or_else(|| ApiError::invalid("A canonical operationId is required"))?;
    let target_directory =
        target_directory.ok_or_else(|| ApiError::invalid("targetDirectory is required"))?;
    let file_name = file_name.ok_or_else(|| ApiError::invalid("fileName is required"))?;
    let bytes = bytes.ok_or_else(|| ApiError::invalid("An image file is required"))?;
    let input = ImageUpload {
        operation_id,
        target_directory,
        file_name,
        conflict_policy: conflict_policy.unwrap_or_default(),
        base_revision,
        bytes,
    };
    let value = run(move || upload_image(&service, &account, &ws, input)).await?;
    Ok((StatusCode::CREATED, Json(value)))
}

fn multipart_error(_: axum::extract::multipart::MultipartError) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_multipart",
        "Could not read the image upload",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_content_types_are_stable() {
        assert_eq!(content_type_for("a.png"), "image/png");
        assert_eq!(content_type_for("a.JPEG"), "image/jpeg");
        assert_eq!(content_type_for("a.svg"), "application/octet-stream");
    }

    #[test]
    fn joins_directories_without_double_slashes() {
        assert_eq!(join_path("", "a.png"), "a.png");
        assert_eq!(join_path("notes", "a.png"), "notes/a.png");
    }
}
