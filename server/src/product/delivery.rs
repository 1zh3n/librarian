use std::{
    collections::{btree_map::Entry, BTreeMap},
    io::{Cursor, Read, Seek},
    path::Path as DiskPath,
    sync::Arc,
};

use axum::{
    extract::{
        rejection::JsonRejection, DefaultBodyLimit, FromRequest, Path, Query, Request, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;
use unicode_normalization_alignments::UnicodeNormalization;
use uuid::Uuid;
use zip::ZipArchive;

use crate::{
    auth::{AccessLevel, Actor},
    multi::instance::SpaceInstance,
};

use super::{
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::{body, product_read, run, state, too_large, DocumentService},
    mutations::{self, FileChange, FileEdit, MutationContext, MAX_BATCH_BYTES, MAX_FILES},
};

const MAX_ARCHIVE_BYTES: usize = 18 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 33 * 1024 * 1024;
const TOKEN_PREFIX: &str = "ldv_";
const TOKEN_LIFETIME_SECONDS: i64 = 90 * 86_400;

pub(super) fn migrate(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "CREATE TABLE deliveries (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           delivery_id TEXT NOT NULL,
           fingerprint TEXT NOT NULL,
           operation_id TEXT NOT NULL UNIQUE,
           account TEXT NOT NULL,
           previous_operation_id TEXT,
           manifest TEXT NOT NULL,
           files TEXT NOT NULL,
           receipt TEXT,
           PRIMARY KEY(workspace_id, delivery_id, fingerprint)
         );
         CREATE INDEX delivery_by_workspace ON deliveries(workspace_id, delivery_id);
         CREATE TABLE delivery_tokens (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           digest TEXT NOT NULL UNIQUE,
           creator TEXT NOT NULL,
           revoked INTEGER NOT NULL DEFAULT 0
         );",
    )
}

pub(super) fn migrate_scoped_tokens(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "ALTER TABLE delivery_tokens ADD COLUMN delivery_id TEXT;
         ALTER TABLE delivery_tokens ADD COLUMN expires_at INTEGER;
         UPDATE delivery_tokens SET revoked = 1;",
    )
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeliveryManifest {
    pub delivery_id: String,
    pub source_name: String,
    pub version: Option<String>,
    pub generated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeliveryRequest {
    pub manifest: DeliveryManifest,
    files: Option<Vec<EncodedFile>>,
    archive_base64: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EncodedFile {
    path: String,
    content_base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeliveryReceipt {
    delivery_id: String,
    workspace_id: String,
    operation_id: String,
    commit_id: String,
    manifest: DeliveryManifest,
    changes: Vec<FileChange>,
}

type Files = BTreeMap<String, Vec<u8>>;
type Revisions = BTreeMap<String, String>;

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route(
            "/workspaces/{workspace}/deliveries",
            get(list)
                .post(deliver)
                .layer(DefaultBodyLimit::max(MAX_JSON_BYTES)),
        )
        .route(
            "/workspaces/{workspace}/delivery-tokens",
            get(list_tokens).post(issue_token),
        )
        .route(
            "/workspaces/{workspace}/delivery-tokens/{token}",
            delete(revoke_token),
        )
        .route("/workspaces/{workspace}/assets/{*path}", get(asset))
}

async fn deliver(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<DeliveryReceipt>), ApiError> {
    let headers = request.headers().clone();
    let archive = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/zip"))
        });
    let lookup = service.clone();
    let target = workspace.clone();
    let initial_headers = headers.clone();
    let archive_manifest = if archive {
        let Query(manifest) =
            Query::<DeliveryManifest>::try_from_uri(request.uri()).map_err(|_| {
                ApiError::invalid("A ZIP delivery requires its manifest query parameters")
            })?;
        validate_manifest(&manifest)?;
        Some(manifest)
    } else {
        None
    };
    let initial_feed = archive_manifest
        .as_ref()
        .map(|manifest| manifest.delivery_id.clone());
    run(move || {
        delivery_principal(&lookup, &target, &initial_headers, initial_feed.as_deref()).map(drop)
    })
    .await?;
    let result = if let Some(manifest) = archive_manifest {
        let mut spool = spool_archive(request.into_body()).await?;
        run(move || {
            let mut payload = Payload::default();
            spool.rewind().map_err(ApiError::internal)?;
            read_zip(spool, &mut payload)?;
            import_from_headers(&service, &workspace, &headers, manifest, payload.finish()?)
        })
        .await?
    } else {
        let request = body(Json::<DeliveryRequest>::from_request(request, &service).await)?;
        run(move || {
            let (manifest, files) = decode(request)?;
            import_from_headers(&service, &workspace, &headers, manifest, files)
        })
        .await?
    };
    Ok((StatusCode::CREATED, Json(result)))
}

fn import_from_headers(
    service: &DocumentService,
    workspace: &str,
    headers: &HeaderMap,
    manifest: DeliveryManifest,
    files: Files,
) -> Result<DeliveryReceipt, ApiError> {
    let _workspace_guard = service.metadata.workspace_guard()?;
    let (instance, actor) =
        delivery_principal(service, workspace, headers, Some(&manifest.delivery_id))?;
    import(service, workspace, &instance, &actor, manifest, files)
}

async fn spool_archive(body: axum::body::Body) -> Result<std::fs::File, ApiError> {
    let file = tempfile::tempfile().map_err(ApiError::internal)?;
    let mut file = tokio::fs::File::from_std(file);
    let mut stream = body.into_data_stream();
    let mut size = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::invalid("Could not read the ZIP upload"))?;
        size += chunk.len();
        if size > MAX_ARCHIVE_BYTES {
            return Err(too_large());
        }
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    file.flush().await.map_err(ApiError::internal)?;
    Ok(file.into_std().await)
}
pub(super) fn publish(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    request: DeliveryRequest,
) -> Result<DeliveryReceipt, ApiError> {
    let (manifest, files) = decode(request)?;
    let _workspace_guard = service.metadata.workspace_guard()?;
    let (instance, actor) = service.scope(account, workspace, true)?;
    import(service, workspace, &instance, &actor, manifest, files)
}

fn delivery_principal(
    service: &DocumentService,
    workspace: &str,
    headers: &HeaderMap,
    delivery_id: Option<&str>,
) -> Result<(Arc<SpaceInstance>, Actor), ApiError> {
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, token)| {
            scheme.eq_ignore_ascii_case("bearer") && token.starts_with(TOKEN_PREFIX)
        });
    let Some((_, token)) = credential else {
        return service.scope(
            &Account::authenticate(&service.spaces, headers, true)?,
            workspace,
            true,
        );
    };
    let grant: Option<(String, String, String, String)> = service
        .metadata
        .connection()?
        .query_row(
            "SELECT id, workspace_id, name, delivery_id FROM delivery_tokens
             WHERE digest = ?1 AND revoked = 0 AND expires_at > ?2 AND delivery_id IS NOT NULL",
            params![sha256_hex(token.as_bytes()), chrono::Utc::now().timestamp()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (id, permitted, name, feed) = grant.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_delivery_token",
            "Delivery credential is invalid, expired, or revoked",
        )
    })?;
    if permitted != workspace {
        return Err(ApiError::not_found());
    }
    if delivery_id.is_some_and(|requested| requested != feed) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "delivery_scope_mismatch",
            "Delivery credential is assigned to a different delivery ID",
        ));
    }
    let space_id = service.metadata.space_id(workspace)?;
    let instance = service
        .spaces
        .manager
        .instance(&space_id)
        .ok_or_else(ApiError::not_found)?;
    if instance.config.read_only {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "read_only",
            "Workspace is read-only",
        ));
    }
    Ok((
        instance,
        Actor {
            full_name: Some(format!("Delivery {name}")),
            username: Some(format!("delivery:{id}")),
            level: AccessLevel::Write,
            ..Actor::default()
        },
    ))
}

fn import(
    service: &DocumentService,
    workspace: &str,
    instance: &SpaceInstance,
    actor: &Actor,
    manifest: DeliveryManifest,
    files: Files,
) -> Result<DeliveryReceipt, ApiError> {
    let db = &service.metadata;
    let state = state(instance)?;
    let engine = state
        .revisions
        .as_deref()
        .filter(|engine| engine.store().auto_commit_allowed())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "revisions_unavailable",
                "Deliveries require managed revisions",
            )
        })?;
    let revisions: Revisions = files
        .iter()
        .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
        .collect();
    let fingerprint =
        sha256_hex(&serde_json::to_vec(&(&manifest, &revisions)).map_err(ApiError::internal)?);
    let account = actor
        .username
        .as_deref()
        .ok_or_else(|| ApiError::internal("Delivery has no actor"))?;
    engine.with_managed_write(|transaction| {
        super::documents::check_storage_recovery(state)?;
        let workspace_info = super::workspace::info(db, workspace)?;
        if workspace_info
            .expires_at
            .is_some_and(|expiry| expiry <= chrono::Utc::now().timestamp())
        {
            return Err(ApiError::new(
                StatusCode::GONE,
                "workspace_expired",
                "This Workspace has expired",
            ));
        }
        let intent = DeliveryIntent::get(db, workspace, &manifest, &fingerprint)?;
        if let Some(receipt) = intent.as_ref().and_then(|intent| intent.receipt.as_ref()) {
            return serde_json::from_str(receipt).map_err(ApiError::internal);
        }
        let previous = DeliveryIntent::latest(db, workspace, &manifest.delivery_id)?;
        let last_operation = previous
            .as_ref()
            .map(|previous| previous.operation.as_str());
        let intent = match intent {
            Some(intent) => intent,
            None => DeliveryIntent::begin(
                db,
                workspace,
                &manifest,
                &fingerprint,
                &revisions,
                account,
                last_operation,
            )?,
        };
        let recorded = mutations::receipt(db, &intent.operation, workspace, &intent.account)?;
        let (commit_id, changes) = if let Some(receipt) = recorded {
            (receipt.commit_id, receipt.changes)
        } else if intent.previous_operation.as_deref() != last_operation {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "delivery_base_changed",
                "A more recent delivery already completed",
            ));
        } else if let Some(previous) = previous
            .as_ref()
            .filter(|previous| previous.files == revisions)
        {
            // A new version label can point at the same immutable content.
            verify_existing_files(state, &manifest.delivery_id, &revisions)?;
            (previous.commit_id.clone(), Vec::new())
        } else {
            let old = previous.map(|previous| previous.files).unwrap_or_default();
            let edits = file_edits(&manifest.delivery_id, old, files);
            let result = MutationContext {
                metadata: db,
                state,
                actor,
                workspace,
                account: &intent.account,
                operation: &intent.operation,
            }
            .apply_files(transaction, edits, "Import delivered documents")?;
            (result.commit_id, result.changes)
        };
        let receipt = DeliveryReceipt {
            delivery_id: manifest.delivery_id.clone(),
            workspace_id: workspace.to_owned(),
            operation_id: intent.operation,
            commit_id,
            manifest,
            changes,
        };
        save_receipt(db, &receipt)?;
        Ok(receipt)
    })
}

struct DeliveryIntent {
    operation: String,
    account: String,
    receipt: Option<String>,
    previous_operation: Option<String>,
}

struct PriorDelivery {
    operation: String,
    files: Revisions,
    commit_id: String,
}

impl DeliveryIntent {
    fn get(
        db: &Metadata,
        workspace: &str,
        manifest: &DeliveryManifest,
        fingerprint: &str,
    ) -> Result<Option<Self>, ApiError> {
        Ok(db
            .connection()?
            .query_row(
                "SELECT operation_id, account, receipt, previous_operation_id FROM deliveries
             WHERE workspace_id = ?1 AND delivery_id = ?2 AND fingerprint = ?3",
                params![workspace, manifest.delivery_id, fingerprint],
                |row| {
                    Ok(Self {
                        operation: row.get(0)?,
                        account: row.get(1)?,
                        receipt: row.get(2)?,
                        previous_operation: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    fn begin(
        db: &Metadata,
        workspace: &str,
        manifest: &DeliveryManifest,
        fingerprint: &str,
        files: &Revisions,
        account: &str,
        previous_operation: Option<&str>,
    ) -> Result<Self, ApiError> {
        let operation = Uuid::new_v4().to_string();
        let metadata = serde_json::to_string(manifest).map_err(ApiError::internal)?;
        let digests = serde_json::to_string(files).map_err(ApiError::internal)?;
        db.connection()?.execute(
            "INSERT INTO deliveries
             (workspace_id, delivery_id, fingerprint, operation_id, account, manifest, files, previous_operation_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![workspace, manifest.delivery_id, fingerprint, operation, account, metadata, digests, previous_operation],
        )?;
        Ok(Self {
            operation,
            account: account.to_owned(),
            receipt: None,
            previous_operation: previous_operation.map(str::to_owned),
        })
    }

    fn latest(
        db: &Metadata,
        workspace: &str,
        delivery: &str,
    ) -> Result<Option<PriorDelivery>, ApiError> {
        let row: Option<(String, String, String)> = db.connection()?.query_row(
            "SELECT operation_id, files, receipt FROM deliveries WHERE workspace_id = ?1 AND delivery_id = ?2
             AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            params![workspace, delivery],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        row.map(|(operation, files, receipt)| {
            let receipt: DeliveryReceipt =
                serde_json::from_str(&receipt).map_err(ApiError::internal)?;
            Ok(PriorDelivery {
                operation,
                files: serde_json::from_str(&files).map_err(ApiError::internal)?,
                commit_id: receipt.commit_id,
            })
        })
        .transpose()
    }
}

fn save_receipt(db: &Metadata, receipt: &DeliveryReceipt) -> Result<(), ApiError> {
    let encoded = serde_json::to_string(receipt).map_err(ApiError::internal)?;
    db.connection()?.execute(
        "UPDATE deliveries SET receipt = ?2 WHERE operation_id = ?1",
        params![receipt.operation_id, encoded],
    )?;
    Ok(())
}

fn physical_path(delivery: &str, path: &str) -> String {
    format!("deliveries/{delivery}/{path}")
}

fn file_edits(delivery: &str, mut old: Revisions, files: Files) -> Vec<FileEdit> {
    let mut edits = Vec::with_capacity(old.len().max(files.len()));
    for (path, contents) in files {
        let target = physical_path(delivery, &path);
        edits.push(FileEdit {
            path: target,
            base_revision: old.remove(&path),
            contents: Some(contents),
        });
    }
    edits.extend(old.into_iter().map(|(path, revision)| FileEdit {
        path: physical_path(delivery, &path),
        base_revision: Some(revision),
        contents: None,
    }));
    edits
}

fn verify_existing_files(
    state: &crate::state::ServerState,
    delivery: &str,
    revisions: &Revisions,
) -> Result<(), ApiError> {
    let root = DiskPath::new(&state.space_folder_path);
    for (path, expected) in revisions {
        let target = physical_path(delivery, path);
        let present = mutations::current_bytes(root, state.space.as_ref(), &target)?
            .as_deref()
            .map(sha256_hex);
        if present.as_ref() != Some(expected) {
            return Err(ApiError::conflict(present));
        }
    }
    Ok(())
}

pub(super) fn recover_startup(db: &Metadata) -> Result<(), ApiError> {
    let pending = {
        let connection = db.connection()?;
        let mut query = connection.prepare(
            "SELECT workspace_id, operation_id, account, manifest FROM deliveries WHERE receipt IS NULL",
        )?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (workspace, operation, account, manifest) in pending {
        if let Some(commit) = mutations::receipt(db, &operation, &workspace, &account)? {
            let manifest: DeliveryManifest =
                serde_json::from_str(&manifest).map_err(ApiError::internal)?;
            save_receipt(
                db,
                &DeliveryReceipt {
                    workspace_id: workspace,
                    operation_id: operation,
                    delivery_id: manifest.delivery_id.clone(),
                    commit_id: commit.commit_id,
                    changes: commit.changes,
                    manifest,
                },
            )?;
        }
    }
    Ok(())
}

fn decode(request: DeliveryRequest) -> Result<(DeliveryManifest, Files), ApiError> {
    let manifest = request.manifest;
    validate_manifest(&manifest)?;
    Ok((
        manifest,
        decode_files(request.files, request.archive_base64)?,
    ))
}

pub(super) fn decode_files(
    files: Option<Vec<EncodedFile>>,
    archive_base64: Option<String>,
) -> Result<Files, ApiError> {
    let mut validated = Payload::default();
    match (files, archive_base64) {
        (Some(files), None) => {
            if files.len() > MAX_FILES {
                return Err(too_large());
            }
            for item in files {
                let bytes =
                    decode_base64(&item.content_base64, mutations::max_file_bytes(&item.path))?;
                validated.insert(item.path, bytes)?;
            }
        }
        (None, Some(archive)) => {
            let encoded = decode_base64(&archive, MAX_ARCHIVE_BYTES)?;
            read_zip(Cursor::new(encoded), &mut validated)?;
        }
        _ => return Err(ApiError::invalid("Provide either files or a ZIP archive")),
    }
    validated.finish()
}

fn validate_manifest(manifest: &DeliveryManifest) -> Result<(), ApiError> {
    if !valid_delivery_id(&manifest.delivery_id)
        || !bounded_label(&manifest.source_name, 128)
        || manifest
            .version
            .as_ref()
            .is_some_and(|version| !bounded_label(version, 96))
        || manifest
            .generated_at
            .as_deref()
            .is_some_and(|time| chrono::DateTime::parse_from_rfc3339(time).is_err())
    {
        return Err(ApiError::invalid("Invalid delivery manifest"));
    }
    Ok(())
}

fn valid_delivery_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[derive(Default)]
struct Payload {
    files: Files,
    normalized: BTreeMap<String, (String, bool)>,
    bytes: usize,
}

impl Payload {
    fn finish(self) -> Result<Files, ApiError> {
        if self.files.is_empty() {
            return Err(ApiError::invalid("A delivery requires at least one file"));
        }
        Ok(self.files)
    }

    fn register_path(&mut self, path: &str, directory: bool) -> Result<(), ApiError> {
        if !included_path(path) {
            return Err(ApiError::invalid(
                "Delivery contains an unsafe relative path",
            ));
        }
        let ends = path
            .match_indices('/')
            .map(|(index, _)| index)
            .chain(std::iter::once(path.len()));
        for end in ends {
            let segment = &path[..end];
            let is_directory = directory || end != path.len();
            let key = segment
                .nfc()
                .map(|(character, _)| character)
                .collect::<String>()
                .to_lowercase();
            match self.normalized.entry(key) {
                Entry::Vacant(entry) => {
                    entry.insert((segment.to_owned(), is_directory));
                }
                Entry::Occupied(entry) => {
                    let (original, was_directory) = entry.get();
                    if original != segment || !is_directory || !was_directory {
                        return Err(ApiError::invalid(
                            "Delivery contains duplicate or aliased paths",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    fn insert(&mut self, path: String, bytes: Vec<u8>) -> Result<(), ApiError> {
        self.register_path(&path, false)?;
        self.bytes += bytes.len();
        if self.files.len() >= MAX_FILES
            || self.bytes > MAX_BATCH_BYTES
            || bytes.len() > mutations::max_file_bytes(&path)
        {
            return Err(too_large());
        }
        if path.to_ascii_lowercase().ends_with(".md") && std::str::from_utf8(&bytes).is_err() {
            return Err(ApiError::invalid("Delivered Markdown must be UTF-8"));
        }
        self.files.insert(path, bytes);
        Ok(())
    }
}

fn read_zip(input: impl Read + std::io::Seek, output: &mut Payload) -> Result<(), ApiError> {
    let invalid = |_| ApiError::invalid("Invalid ZIP archive");
    let mut zip = ZipArchive::new(input).map_err(invalid)?;
    if zip.len() > MAX_FILES * 2 {
        return Err(too_large());
    }
    for number in 0..zip.len() {
        let mut file = zip.by_index(number).map_err(invalid)?;
        let path = file
            .name()
            .map_err(|_| ApiError::invalid("Invalid ZIP entry name"))?
            .trim_end_matches('/')
            .to_owned();
        if file.is_symlink() || file.enclosed_name().is_none() || !included_path(&path) {
            return Err(ApiError::invalid("ZIP contains an unsafe entry"));
        }
        if file.is_dir() {
            output.register_path(&path, true)?;
            continue;
        }
        let maximum =
            mutations::max_file_bytes(&path).min(MAX_BATCH_BYTES.saturating_sub(output.bytes));
        if file.size() > maximum as u64 {
            return Err(too_large());
        }
        let mut bytes = Vec::with_capacity(file.size() as usize);
        (&mut file)
            .take((maximum + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ApiError::invalid("Could not read ZIP entry"))?;
        if bytes.len() > maximum {
            return Err(too_large());
        }
        output.insert(path, bytes)?;
    }
    Ok(())
}

fn decode_base64(value: &str, maximum: usize) -> Result<Vec<u8>, ApiError> {
    if value.len() > maximum.div_ceil(3) * 4 {
        return Err(too_large());
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| ApiError::invalid("Invalid Base64 content"))?;
    if bytes.len() > maximum {
        return Err(too_large());
    }
    Ok(bytes)
}

pub(super) fn included_path(path: &str) -> bool {
    mutations::valid_file_path(path)
        && path.split('/').all(|part| {
            !part.starts_with('.')
                && !part.ends_with(['.', ' '])
                && !part.contains(['*', '?', '"', '<', '>', '|'])
        })
}

fn bounded_label(label: &str, limit: usize) -> bool {
    !label.trim().is_empty() && label.len() <= limit && !label.chars().any(char::is_control)
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeliveryReceipt>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        service.scope(&account, &workspace, false)?;
        let connection = service.metadata.connection()?;
        let mut query = connection.prepare(
            "SELECT receipt FROM deliveries WHERE workspace_id = ?1 AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 100",
        )?;
        let rows = query.query_map([workspace], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Json(rows.iter().map(|row| serde_json::from_str(row).map_err(ApiError::internal)).collect::<Result<Vec<_>, _>>()?))
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewToken {
    name: String,
    delivery_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenSummary {
    id: String,
    name: String,
    revoked: bool,
    delivery_id: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Serialize)]
struct IssuedToken {
    #[serde(flatten)]
    summary: TokenSummary,
    token: String,
}

async fn issue_token(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
    request: Result<Json<NewToken>, JsonRejection>,
) -> Result<(StatusCode, Json<IssuedToken>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    run(move || {
        let _workspace_guard = service.metadata.workspace_guard()?;
        super::workspace::require_manage(&service, &account, &workspace)?;
        let name = request.name.trim();
        if !bounded_label(name, 64) {
            return Err(ApiError::invalid("A short token name is required"));
        }
        if !valid_delivery_id(&request.delivery_id) {
            return Err(ApiError::invalid("Provide the delivery ID this credential will use"));
        }
        let id = Uuid::new_v4().to_string();
        let expires_at = chrono::Utc::now().timestamp() + TOKEN_LIFETIME_SECONDS;
        let token = format!("{TOKEN_PREFIX}{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let digest = sha256_hex(token.as_bytes());
        service.metadata.connection()?.execute(
            "INSERT INTO delivery_tokens (id, workspace_id, name, digest, creator, delivery_id, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, workspace, name, digest, account.username(), request.delivery_id, expires_at],
        )?;
        Ok((StatusCode::CREATED, Json(IssuedToken {
            summary: TokenSummary {
                id, name: name.to_owned(), revoked: false,
                delivery_id: Some(request.delivery_id), expires_at: Some(expires_at),
            }, token,
        })))
    }).await
}

async fn list_tokens(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<TokenSummary>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let _workspace_guard = service.metadata.workspace_guard()?;
        super::workspace::require_manage(&service, &account, &workspace)?;
        let connection = service.metadata.connection()?;
        let mut query = connection.prepare(
            "SELECT id, name, revoked, delivery_id, expires_at FROM delivery_tokens
             WHERE workspace_id = ?1 ORDER BY rowid DESC LIMIT 100",
        )?;
        let rows = query
            .query_map([workspace], |row| {
                Ok(TokenSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    revoked: row.get(2)?,
                    delivery_id: row.get(3)?,
                    expires_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Json(rows))
    })
    .await
}

async fn revoke_token(
    State(service): State<Arc<DocumentService>>,
    Path((workspace, token)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || {
        let _workspace_guard = service.metadata.workspace_guard()?;
        super::workspace::require_manage(&service, &account, &workspace)?;
        let changed = service.metadata.connection()?.execute(
            "UPDATE delivery_tokens SET revoked = 1 WHERE id = ?1 AND workspace_id = ?2",
            params![token, workspace],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found());
        }
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn asset(
    State(service): State<Arc<DocumentService>>,
    Path((workspace, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        if !included_path(&path) || path.to_ascii_lowercase().ends_with(".md") {
            return Err(ApiError::not_found());
        }
        let (instance, _) = service.scope(&account, &workspace, false)?;
        let state = state(&instance)?;
        let _read = product_read(state)?;
        let root = DiskPath::new(&state.space_folder_path);
        let bytes = mutations::current_bytes(root, state.space.as_ref(), &path)?
            .ok_or_else(ApiError::not_found)?;
        Ok(workspace_asset_response(&path, bytes, &headers))
    })
    .await
}

pub(super) fn workspace_asset_response(
    path: &str,
    bytes: Vec<u8>,
    request_headers: &HeaderMap,
) -> Response {
    let revision = sha256_hex(&bytes);
    let etag = format!("\"{revision}\"");
    let not_modified = request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*" || candidate.trim_start_matches("W/") == etag
            })
        });
    if not_modified {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        response.headers_mut().insert(
            header::ETAG,
            header::HeaderValue::from_str(&etag).expect("ETag is a valid header value"),
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("private, no-cache"),
        );
        response.headers_mut().insert(
            header::X_CONTENT_TYPE_OPTIONS,
            header::HeaderValue::from_static("nosniff"),
        );
        response.headers_mut().insert(
            header::HeaderName::from_static("x-content-revision"),
            header::HeaderValue::from_str(&revision).expect("revision is a valid header value"),
        );
        response
    } else {
        let mut response = binary_response(path, bytes);
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("private, no-cache"),
        );
        response.headers_mut().insert(
            header::ETAG,
            header::HeaderValue::from_str(&etag).expect("ETag is a valid header value"),
        );
        response.headers_mut().insert(
            header::HeaderName::from_static("x-content-revision"),
            header::HeaderValue::from_str(&revision).expect("revision is a valid header value"),
        );
        response
    }
}

pub(super) fn binary_response(path: &str, bytes: Vec<u8>) -> Response {
    let extension = DiskPath::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    };
    let mut response = (
        [
            (header::CONTENT_TYPE, content_type),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response();
    if content_type == "application/octet-stream" {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            header::HeaderValue::from_static("attachment"),
        );
    }
    response
}

#[cfg(test)]
mod asset_response_tests {
    use super::*;

    #[test]
    fn workspace_asset_response_revalidates_with_a_content_etag() {
        let response = workspace_asset_response("photo.png", b"first".to_vec(), &HeaderMap::new());
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache"
        );
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        let etag = response.headers()[header::ETAG].clone();
        assert!(etag.to_str().unwrap().starts_with('"'));

        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, etag);
        let response = workspace_asset_response("photo.png", b"first".to_vec(), &headers);
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(response.headers().contains_key(header::ETAG));

        let response = workspace_asset_response("photo.png", b"second".to_vec(), &headers);
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn workspace_asset_response_never_inlines_svg() {
        let response = workspace_asset_response("icon.svg", b"<svg/>".to_vec(), &HeaderMap::new());
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment"
        );
    }
}
