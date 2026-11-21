pub(super) mod restored;

use std::sync::Arc;

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;

use crate::{
    revisions::{read, RevisionEngine},
    state::ServerState,
};

use super::{
    auth::Account,
    contract::{ApiError, DocumentSnapshot, RestoreRevision},
    documents::{
        body, check_file_path, check_storage_recovery, product_read, read_markdown, run, state,
        too_large, DocumentService, MARKDOWN_LIMIT,
    },
};

pub(super) fn mode(engine: Option<&RevisionEngine>) -> &'static str {
    match engine {
        Some(engine) if engine.store().auto_commit_allowed() => "managed",
        Some(engine) if engine.store().repo_root().is_some() => "repository",
        _ => "disabled",
    }
}

fn engine(state: &ServerState) -> Result<&RevisionEngine, ApiError> {
    state
        .revisions
        .as_deref()
        .filter(|engine| engine.store().repo_root().is_some())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "revisions_disabled",
                "Version history is unavailable for this workspace",
            )
        })
}

pub(super) fn validate_commit(value: &str) -> Result<(), ApiError> {
    if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::invalid("Expected a Git commit ID"));
    }
    Ok(())
}

#[derive(Deserialize)]
pub(super) struct HistoryQuery {
    pub before: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    commit_id: String,
    timestamp: i64,
    author: String,
    message: String,
    added: u64,
    removed: u64,
}

#[derive(Serialize)]
pub(super) struct History {
    mode: &'static str,
    uncommitted: bool,
    revisions: Vec<HistoryEntry>,
    more: bool,
}

pub(super) async fn history(
    State(service): State<Arc<DocumentService>>,
    Path(document): Path<String>,
    query: Result<Query<HistoryQuery>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Json<History>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid history query"))?;
    run(move || document_history(&service, &account, &document, query))
        .await
        .map(Json)
}

pub(super) fn document_history(
    service: &DocumentService,
    account: &Account,
    document: &str,
    query: HistoryQuery,
) -> Result<History, ApiError> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("limit must be between 1 and 100"));
    }
    if let Some(before) = &query.before {
        validate_commit(before)?;
    }
    let (instance, _, workspace, _) = service.document_scope(account, document, false)?;
    let state = state(&instance)?;
    let _mutation = product_read(state)?;
    let path = service.path_in(&workspace, document)?;
    check_file_path(state, &path)?;
    state.space.get_file_meta(&path)?;
    let engine = engine(state)?;
    let mode = mode(Some(engine));
    if !engine.store().head_exists() {
        return Ok(History {
            mode,
            uncommitted: true,
            revisions: Vec::new(),
            more: false,
        });
    }
    let result = restored::Lineage::load(
        &service.metadata,
        engine.store(),
        &workspace,
        document,
        &path,
    )?
    .page(query.before.as_deref(), limit)?;
    let uncommitted = engine
        .store()
        .exact_markdown_uncommitted(&path)
        .map_err(ApiError::internal)?
        .unwrap_or(result.uncommitted);
    let revisions = result
        .revisions
        .into_iter()
        .map(|entry| HistoryEntry {
            commit_id: entry.rev,
            timestamp: entry.timestamp,
            author: entry.author,
            message: entry.message,
            added: entry.added,
            removed: entry.removed,
        })
        .collect();
    Ok(History {
        mode,
        uncommitted,
        revisions,
        more: result.more,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VersionDiff {
    commit_id: String,
    diff: String,
    markdown: Option<String>,
}

pub(super) async fn diff(
    State(service): State<Arc<DocumentService>>,
    Path((document, commit)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<VersionDiff>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || document_diff(&service, &account, &document, commit))
        .await
        .map(Json)
}

pub(super) fn document_diff(
    service: &DocumentService,
    account: &Account,
    document: &str,
    commit: String,
) -> Result<VersionDiff, ApiError> {
    validate_commit(&commit)?;
    let (instance, _, workspace, _) = service.document_scope(account, document, false)?;
    let state = state(&instance)?;
    let _mutation = product_read(state)?;
    let path = service.path_in(&workspace, document)?;
    check_file_path(state, &path)?;
    state.space.get_file_meta(&path)?;
    let engine = engine(state)?;
    let path = restored::Lineage::load(
        &service.metadata,
        engine.store(),
        &workspace,
        document,
        &path,
    )?
    .path_at(&commit)?
    .ok_or_else(ApiError::not_found)?;
    let diff = read::RevisionPath::Recorded(&path)
        .diff(engine.store(), &commit, false)
        .map_err(ApiError::internal)?
        .ok_or_else(ApiError::not_found)?;
    let markdown = read::RevisionPath::Recorded(&path)
        .bytes(engine.store(), &commit, false)
        .map_err(ApiError::internal)?
        .map(text)
        .transpose()?;
    if diff.len() > MARKDOWN_LIMIT * 3 {
        return Err(too_large());
    }
    Ok(VersionDiff {
        commit_id: commit,
        diff,
        markdown,
    })
}

pub(super) fn historical_markdown(
    service: &DocumentService,
    engine: &RevisionEngine,
    workspace: &str,
    document: &str,
    path: &str,
    commit: &str,
) -> Result<Option<String>, ApiError> {
    let Some(historical) =
        restored::Lineage::load(&service.metadata, engine.store(), workspace, document, path)?
            .path_at(commit)?
    else {
        return Ok(None);
    };
    read::RevisionPath::Recorded(&historical)
        .bytes(engine.store(), commit, false)
        .map_err(ApiError::internal)?
        .map(text)
        .transpose()
}

fn text(bytes: Vec<u8>) -> Result<String, ApiError> {
    if bytes.len() > MARKDOWN_LIMIT {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| ApiError::invalid("Version is not UTF-8 Markdown"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Restored {
    snapshot: DocumentSnapshot,
    commit_id: String,
}

pub(super) async fn restore(
    State(service): State<Arc<DocumentService>>,
    Path(document): Path<String>,
    headers: HeaderMap,
    request: Result<Json<RestoreRevision>, JsonRejection>,
) -> Result<Json<Restored>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    validate_commit(&request.commit_id)?;
    run(move || {
        let (instance, actor, workspace, _) = service.document_scope(&account, &document, true)?;
        let state = state(&instance)?;
        let engine = engine(state)?;
        if !engine.store().auto_commit_allowed() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "revisions_read_only",
                "Librarian cannot restore versions for this repository",
            ));
        }
        let expected = request.precondition()?;
        engine.with_managed_write(|transaction| {
            check_storage_recovery(state)?;
            let path = service.path_in(&workspace, &document)?;
            let current = read_markdown(state, &path)?;
            let current_revision = sha256_hex(current.as_bytes());
            if current_revision != expected {
                return Err(ApiError::conflict(Some(current_revision)));
            }
            let restored = historical_markdown(
                &service,
                engine,
                &workspace,
                &document,
                &path,
                &request.commit_id,
            )?
            .ok_or_else(ApiError::not_found)?;
            if current == restored {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "already_current",
                    "This version matches the current document",
                ));
            }
            let operation = uuid::Uuid::new_v4().to_string();
            let context = super::mutations::MutationContext {
                metadata: &service.metadata,
                state,
                actor: &actor,
                workspace: &workspace,
                account: account.username(),
                operation: &operation,
            };
            let receipt = context.apply_named(
                transaction,
                vec![super::mutations::MutationEdit {
                    path: path.clone(),
                    base_revision: Some(current_revision),
                    markdown: Some(restored.clone()),
                }],
                "Restore document version",
            )?;
            let revision = sha256_hex(restored.as_bytes());
            Ok(Json(Restored {
                snapshot: service.snapshot(state, &workspace, document, path, restored, revision),
                commit_id: receipt.commit_id,
            }))
        })
    })
    .await
}
