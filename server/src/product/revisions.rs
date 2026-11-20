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
        body, check_file_path, note_file_write, read_markdown, run, snapshot, state, too_large,
        DocumentService, MARKDOWN_LIMIT,
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

fn validate_commit(value: &str) -> Result<(), ApiError> {
    if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::invalid("Expected a Git commit ID"));
    }
    Ok(())
}

#[derive(Deserialize)]
pub(super) struct HistoryQuery {
    before: Option<String>,
    limit: Option<usize>,
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
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid("limit must be between 1 and 100"));
    }
    if let Some(before) = &query.before {
        validate_commit(before)?;
    }
    run(move || {
        let (instance, _, _, path) = service.document_scope(&account, &document, false)?;
        let state = state(&instance)?;
        let _mutation = state.fs_guard.mutation.read().map_err(ApiError::internal)?;
        check_file_path(state, &path)?;
        state.space.get_file_meta(&path)?;
        let engine = engine(state)?;
        let mode = mode(Some(engine));
        if !engine.store().head_exists() {
            return Ok(Json(History {
                mode,
                uncommitted: true,
                revisions: Vec::new(),
                more: false,
            }));
        }
        let result = read::file_history(engine.store(), &path, query.before.as_deref(), limit)
            .map_err(ApiError::internal)?;
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
        Ok(Json(History {
            mode,
            uncommitted: result.uncommitted,
            revisions,
            more: result.more,
        }))
    })
    .await
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
    validate_commit(&commit)?;
    run(move || {
        let (instance, _, _, path) = service.document_scope(&account, &document, false)?;
        let state = state(&instance)?;
        let _mutation = state.fs_guard.mutation.read().map_err(ApiError::internal)?;
        check_file_path(state, &path)?;
        state.space.get_file_meta(&path)?;
        let store = engine(state)?.store();
        let diff = read::file_diff(store, &path, &commit, false)
            .map_err(ApiError::internal)?
            .ok_or_else(ApiError::not_found)?;
        let markdown = read::file_at(store, &path, &commit, false)
            .map_err(ApiError::internal)?
            .map(text)
            .transpose()?;
        if diff.len() > MARKDOWN_LIMIT * 3 {
            return Err(too_large());
        }
        Ok(Json(VersionDiff {
            commit_id: commit,
            diff,
            markdown,
        }))
    })
    .await
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
        let (instance, actor, workspace, path) = service.document_scope(&account, &document, true)?;
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
            let current = read_markdown(state, &path)?;
            let current_revision = sha256_hex(current.as_bytes());
            if current_revision != expected {
                return Err(ApiError::conflict(Some(current_revision)));
            }
            let restored = read::file_at(engine.store(), &path, &request.commit_id, false)
                .map_err(ApiError::internal)?
                .ok_or_else(ApiError::not_found)
                .and_then(text)?;
            if current == restored {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "already_current",
                    "This version matches the current document",
                ));
            }
            transaction.checkpoint(&path, &actor).map_err(ApiError::internal)?;
            let file = state.space.write_file(&path, restored.as_bytes(), None)?;
            let commit_id = match transaction
                .commit_file(&path, &actor, "Restore document version")
                .and_then(|id| id.ok_or_else(|| "Restoring the document produced no Git commit".to_string()))
            {
                Ok(id) => id,
                Err(error) => {
                    let previous = state.space.write_file(&path, current.as_bytes(), None)
                        .map_err(|rollback| ApiError::internal(format!(
                            "Could not commit restoration ({error}) or roll back the file ({rollback})"
                        )))?;
                    note_file_write(state, &path, &current_revision, actor, &previous);
                    return Err(ApiError::internal(error));
                }
            };
            let revision = sha256_hex(restored.as_bytes());
            note_file_write(state, &path, &revision, actor, &file);
            engine.notify_file_saved();
            Ok(Json(Restored {
                snapshot: snapshot(state, &workspace, document, path, restored, revision),
                commit_id,
            }))
        })
    }).await
}
