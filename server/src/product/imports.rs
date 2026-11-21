use super::{
    ai,
    auth::Account,
    contract::ApiError,
    delivery::{self, EncodedFile},
    documents::{body, is_document_path, run, state, DocumentService},
    mutations::{FileEdit, MutationContext, MutationReceipt},
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportRequest {
    pub operation_id: String,
    target_directory: String,
    files: Option<Vec<EncodedFile>>,
    archive_base64: Option<String>,
    #[serde(default)]
    updates: Vec<Update>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    path: String,
    base_revision: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedDocument {
    document_id: String,
    path: String,
}

#[derive(Serialize, Deserialize)]
struct ImportReceipt {
    #[serde(flatten)]
    receipt: MutationReceipt,
    documents: Vec<ImportedDocument>,
}

impl ImportReceipt {
    fn view(self, service: &DocumentService) -> Value {
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
        let mut result = json!(self.receipt);
        result["documents"] = json!(documents);
        result
    }
}

fn saved(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    id: &str,
) -> Result<Option<ImportReceipt>, ApiError> {
    let raw:Option<String>=service.metadata.connection()?.query_row(
        "SELECT receipt FROM workspace_imports WHERE operation_id=?1 AND workspace_id=?2 AND owner=?3",
        params![id,ws,account.username()],|r| r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(ApiError::internal))
        .transpose()
}

pub(super) fn import(
    service: &DocumentService,
    account: &Account,
    ws: &str,
    input: ImportRequest,
) -> Result<Value, ApiError> {
    let (instance, actor) = service.scope(account, ws, true)?;
    let state = state(&instance)?;
    let engine = ai::managed_engine(state)?;
    let dir = input.target_directory.trim_end_matches('/');
    if (!input.target_directory.is_empty() && dir.is_empty())
        || (!dir.is_empty() && !delivery::included_path(dir))
    {
        return Err(ApiError::invalid("Select a safe relative target directory"));
    }
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
    let edits = files
        .into_iter()
        .map(|(path, contents)| FileEdit {
            base_revision: updates.remove(&path),
            path: if dir.is_empty() {
                path
            } else {
                format!("{dir}/{path}")
            },
            contents: Some(contents),
        })
        .collect();
    engine.with_managed_write(|tx| {
        let context = MutationContext {
            metadata: &service.metadata,
            state,
            actor: &actor,
            workspace: ws,
            account: account.username(),
            operation: &input.operation_id,
        };
        let receipt = context.apply_files(tx, edits, "Import workspace files")?;
        if let Some(prior) = saved(service, account, ws, &input.operation_id)? {
            return Ok(prior.view(service));
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
        let receipt = ImportReceipt { receipt, documents };
        let encoded = serde_json::to_string(&receipt).map_err(ApiError::internal)?;
        service.metadata.connection()?.execute(
            "INSERT INTO workspace_imports(operation_id,workspace_id,owner,receipt)
             VALUES(?1,?2,?3,?4)",
            params![input.operation_id, ws, account.username(), encoded],
        )?;
        Ok(receipt.view(service))
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
    let saved = saved(service, account, ws, id)?.ok_or_else(ApiError::not_found)?;
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
                    let bytes = crate::revisions::read::file_at(
                        engine.store(),
                        &change.path,
                        &saved.receipt.commit_id,
                        true,
                    )
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
                .view(&service),
        ))
    })
    .await
}
