use super::{
    ai,
    auth::Account,
    contract::ApiError,
    delivery::{self, EncodedFile},
    documents::{body, is_document_path, run, state, DocumentService},
    image_policy,
    mutations::{FileEdit, MutationContext, MutationReceipt},
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;
use std::{collections::BTreeMap, sync::Arc};

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/workspaces/{workspace}/imports", post(upload))
        .route(
            "/workspaces/{workspace}/imports/{operation}",
            get(get_receipt),
        )
        .layer(DefaultBodyLimit::max(34 * 1024 * 1024))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportRequest {
    pub operation_id: String,
    target_directory: String,
    files: Option<Vec<EncodedFile>>,
    archive_base64: Option<String>,
    #[serde(default)]
    updates: Vec<Update>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    path: String,
    base_revision: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportedDocument {
    document_id: String,
    path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportedAsset {
    pub path: String,
    pub revision: String,
    pub content_type: String,
    pub width: usize,
    pub height: usize,
    pub size: usize,
}

#[derive(Serialize, Deserialize)]
pub(super) struct ImportReceipt {
    #[serde(flatten)]
    pub(super) receipt: MutationReceipt,
    pub(super) documents: Vec<ImportedDocument>,
    #[serde(default)]
    pub(super) assets: Vec<ImportedAsset>,
}

impl ImportReceipt {
    pub(super) fn view(self, service: &DocumentService) -> Value {
        let documents = self
            .documents
            .into_iter()
            .map(|doc| {
                let mut fields = json!(service
                    .reader_links
                    .document(&self.receipt.workspace_id, &doc.document_id));
                fields["documentId"] = json!(doc.document_id);
                fields["path"] = json!(doc.path);
                fields
            })
            .collect::<Vec<_>>();
        let assets = self
            .assets
            .iter()
            .map(|asset| {
                let mut fields = json!(service
                    .reader_links
                    .asset(&self.receipt.workspace_id, &asset.path));
                fields["path"] = json!(asset.path);
                fields["revision"] = json!(asset.revision);
                fields["contentType"] = json!(asset.content_type);
                fields["width"] = json!(asset.width);
                fields["height"] = json!(asset.height);
                fields["size"] = json!(asset.size);
                fields
            })
            .collect::<Vec<_>>();
        let mut result = json!(self.receipt);
        result["documents"] = json!(documents);
        result["assets"] = json!(assets);
        result
    }
}

pub(super) fn saved(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    id: &str,
) -> Result<Option<(ImportReceipt, Option<String>)>, ApiError> {
    let row: Option<(String, Option<String>)> = service
        .metadata
        .connection()?
        .query_row(
            "SELECT receipt, digest FROM workspace_imports
             WHERE operation_id=?1 AND workspace_id=?2 AND owner=?3",
            params![id, ws, account.username()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(raw, digest)| {
        serde_json::from_str(&raw)
            .map(|receipt| (receipt, digest))
            .map_err(ApiError::internal)
    })
    .transpose()
}

pub(super) fn operation_reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "operation_id_reused",
        "Operation ID is already bound to another request",
    )
}

pub(super) fn import(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    input: ImportRequest,
) -> Result<Value, ApiError> {
    let digest = sha256_hex(&serde_json::to_vec(&input).map_err(ApiError::internal)?);
    let dir = image_policy::validate_directory(&input.target_directory)?;
    let files = delivery::decode_files(input.files, input.archive_base64)?;
    let mut updates = BTreeMap::new();
    for update in input.updates {
        if !files.contains_key(&update.path)
            || update.base_revision.len() != 64
            || !update
                .base_revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || updates.insert(update.path, update.base_revision).is_some()
        {
            return Err(ApiError::invalid(
                "Each update must identify one uploaded file and its content revision",
            ));
        }
    }
    import_files(
        service,
        account,
        ws,
        ImportFiles {
            operation_id: input.operation_id,
            dir,
            files,
            updates,
            digest,
        },
    )
    .map(|receipt| receipt.view(service))
}

pub(super) struct ImportFiles {
    pub operation_id: String,
    pub dir: String,
    pub files: BTreeMap<String, Vec<u8>>,
    pub updates: BTreeMap<String, String>,
    pub digest: String,
}

pub(super) fn import_files(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    input: ImportFiles,
) -> Result<ImportReceipt, ApiError> {
    let ImportFiles {
        operation_id,
        dir,
        files,
        mut updates,
        digest,
    } = input;
    let (instance, actor) = service.scope(account, ws, true)?;
    let state = state(&instance)?;
    let engine = ai::managed_engine(state)?;
    engine.with_managed_write(|tx| {
        if let Some((prior, prior_digest)) = saved(service, account, ws, &operation_id)? {
            if prior_digest
                .as_deref()
                .is_some_and(|value| value != digest.as_str())
            {
                return Err(operation_reused());
            }
            return Ok(prior);
        }

        let mut edits = Vec::new();
        let mut assets = Vec::new();
        for (source_path, contents) in files {
            let path = if dir.is_empty() {
                source_path.clone()
            } else {
                format!("{dir}/{source_path}")
            };
            if image_policy::is_image_extension(&path) {
                let info = image_policy::inspect(&path, &contents)?;
                assets.push(ImportedAsset {
                    revision: sha256_hex(&contents),
                    content_type: info.kind.content_type().to_owned(),
                    width: info.width,
                    height: info.height,
                    size: contents.len(),
                    path: path.clone(),
                });
            }
            edits.push(FileEdit {
                base_revision: updates.remove(&source_path),
                path,
                contents: Some(contents),
            });
        }
        if !updates.is_empty() {
            return Err(ApiError::invalid(
                "Each update must identify one uploaded file and its content revision",
            ));
        }

        let context = MutationContext {
            metadata: &service.metadata,
            state,
            actor: &actor,
            workspace: ws,
            account: account.username(),
            operation: &operation_id,
        };
        let receipt = context.apply_files(tx, edits, "Import workspace files")?;
        for asset in &mut assets {
            if let Some(change) = receipt
                .changes
                .iter()
                .find(|change| change.path == asset.path)
            {
                if let Some(revision) = &change.revision {
                    asset.revision.clone_from(revision);
                }
            }
        }
        let mut documents = Vec::new();
        for change in &receipt.changes {
            if is_document_path(&change.path) {
                documents.push(ImportedDocument {
                    document_id: service.metadata.document_id(ws, &change.path)?,
                    path: change.path.clone(),
                });
            }
        }
        let receipt = ImportReceipt {
            receipt,
            documents,
            assets,
        };
        let encoded = serde_json::to_string(&receipt).map_err(ApiError::internal)?;
        service.metadata.connection()?.execute(
            "INSERT INTO workspace_imports(operation_id,workspace_id,owner,receipt,digest)
             VALUES(?1,?2,?3,?4,?5)",
            params![operation_id, ws, account.username(), encoded, digest],
        )?;
        Ok(receipt)
    })
}

async fn upload(
    State(service): State<Arc<DocumentService>>,
    Path(ws): Path<String>,
    headers: HeaderMap,
    input: Result<Json<ImportRequest>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || import(&service, &account, &ws, input).map(Json)).await
}

pub(super) fn operation(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    id: &str,
    undo: Option<&str>,
) -> Result<Value, ApiError> {
    let (space, actor) = service.scope(account, ws, undo.is_some())?;
    let (saved, _) = saved(service, account, ws, id)?.ok_or_else(ApiError::not_found)?;
    let Some(undo) = undo else {
        return Ok(saved.view(service));
    };
    let state = state(&space)?;
    let engine = ai::managed_engine(state)?;
    engine.with_managed_write(|tx| {
        let mut edits = Vec::new();
        for change in &saved.receipt.changes {
            let contents = match &change.before_revision {
                Some(before) => {
                    let bytes = crate::revisions::read::RevisionPath::Recorded(&change.path)
                        .bytes(engine.store(), &saved.receipt.commit_id, true)
                        .map_err(ApiError::internal)?
                        .ok_or_else(ApiError::not_found)?;
                    if silverbullet_server_common::revision::sha256_hex(&bytes) != *before {
                        return Err(ApiError::conflict(None));
                    }
                    Some(bytes)
                }
                None => None,
            };
            edits.push(FileEdit {
                path: change.path.clone(),
                base_revision: change.revision.clone(),
                contents,
            });
        }
        let receipt = MutationContext {
            metadata: &service.metadata,
            state,
            actor: &actor,
            workspace: ws,
            account: account.username(),
            operation: undo,
        }
        .apply_files(tx, edits, "Undo workspace import")?;
        Ok(json!(receipt))
    })
}

async fn get_receipt(
    State(service): State<Arc<DocumentService>>,
    Path((ws, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        service.scope(&account, &ws, false)?;
        Ok(Json(
            saved(&service, &account, &ws, &id)?
                .ok_or_else(ApiError::not_found)?
                .0
                .view(&service),
        ))
    })
    .await
}
