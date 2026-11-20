use std::{
    collections::HashSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{rejection::JsonRejection, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

use super::{
    ai::{
        AcceptedResult, Confirmation, ContextRequest, Lease, Mode, Operation, OperationStatus,
        OperationView, SourceReference, TaskInput,
    },
    contract::{content_precondition, present_revision, ApiError, DocumentSummary},
    db::Metadata,
    documents::{body, run, DocumentList, DocumentService},
    mutations::{self, MutationEdit},
};

const LEASE_SECS: i64 = 180;
const MAX_SOURCES: usize = 64;

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/runner/claims", post(claim))
        .route("/ai/runner/claims/{lease}/sources", post(source))
        .route("/ai/runner/claims/{lease}/documents", get(documents))
        .route("/ai/runner/claims/{lease}/events", post(event))
        .route("/ai/runner/claims/{lease}/renew", post(renew))
        .route("/ai/runner/claims/{lease}/fail", post(fail))
        .route("/ai/runner/claims/{lease}/result", put(result))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claimed {
    operation_id: String,
    lease_id: String,
    expires_at: i64,
    input: TaskInput,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn authorize(db: &Metadata, headers: &HeaderMap) -> Result<(), ApiError> {
    let expected = db.runner_digest()?.ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "runner_unconfigured",
            "Configure an external AI runner",
        )
    })?;
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| sha256_hex(token.as_bytes()));
    let matches = authorized.is_some_and(|value| {
        expected
            .bytes()
            .zip(value.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
    });
    if matches {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "runner_unauthorized",
            "A valid runner credential is required",
        ))
    }
}

async fn claim(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    run(move || {
        let db = &service.metadata;
        authorize(db, &headers)?;
        let _guard = db.ai_guard()?;
        let now = now();
        for mut op in Operation::claimable(db, now)? {
            let write = op.view.mode == Mode::Edit;
            let account = match op.actor(&service, write) {
                Ok(account) => account,
                Err(error)
                    if matches!(
                        error.status(),
                        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
                    ) =>
                {
                    op.settle(db, OperationStatus::Canceled)?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if op.accepted.is_some() {
                if let Err(error) = op.apply_result(&service, &account) {
                    if error.status() != StatusCode::CONFLICT {
                        return Err(error);
                    }
                }
                continue;
            }
            let input = op
                .input
                .clone()
                .ok_or_else(|| ApiError::internal("Missing task input"))?;
            let lease_id = Uuid::new_v4().to_string();
            let expires_at = now + LEASE_SECS;
            op.lease = Some(Lease {
                id: lease_id.clone(),
                expires_at,
            });
            op.view.status = OperationStatus::Running;
            op.delivered.clear();
            op.store(db, true)?;
            return Ok(Json(Claimed {
                operation_id: op.view.id,
                lease_id,
                expires_at,
                input,
            })
            .into_response());
        }
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await
}

fn require_running(op: &Operation) -> Result<(), ApiError> {
    if op.view.status == OperationStatus::Running
        && op
            .lease
            .as_ref()
            .is_some_and(|lease| lease.expires_at > now())
        && op.accepted.is_none()
    {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "lease_inactive",
            "The execution lease is no longer active",
        ))
    }
}

#[derive(Deserialize)]
struct Discovery {
    q: Option<String>,
}

async fn documents(
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    Query(discovery): Query<Discovery>,
    headers: HeaderMap,
) -> Result<Json<Vec<DocumentSummary>>, ApiError> {
    let lookup = service.clone();
    let id = lease.clone();
    let (account, workspace) = run(move || {
        authorize(&lookup.metadata, &headers)?;
        let op = Operation::by_lease(&lookup.metadata, &id)?;
        require_running(&op)?;
        Ok((op.actor(&lookup, false)?, op.view.workspace_id))
    })
    .await?;
    if let Some(query) = discovery.q {
        let hits = super::search::find_documents(
            service.clone(),
            account,
            workspace,
            query,
            &HeaderMap::new(),
        )
        .await?;
        run(move || {
            let op = Operation::by_lease(&service.metadata, &lease)?;
            require_running(&op)?;
            op.actor(&service, false)?;
            Ok(Json(hits.into_iter().map(|hit| hit.document).collect()))
        })
        .await
    } else {
        run(move || {
            service
                .list(
                    &account,
                    &workspace,
                    DocumentList {
                        after: None,
                        limit: Some(100),
                    },
                )
                .map(Json)
        })
        .await
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Renewal {
    expires_at: i64,
}

async fn renew(
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Renewal>, ApiError> {
    run(move || {
        let db = &service.metadata;
        authorize(db, &headers)?;
        let _guard = db.ai_guard()?;
        let mut op = Operation::by_lease(db, &lease)?;
        require_running(&op)?;
        op.actor(&service, op.view.mode == Mode::Edit)?;
        let expires_at = now() + LEASE_SECS;
        op.lease.as_mut().expect("active lease").expires_at = expires_at;
        op.store(db, false)?;
        Ok(Json(Renewal { expires_at }))
    })
    .await
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum EventKind {
    Progress,
    TextDelta,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Progress => "progress",
            Self::TextDelta => "text_delta",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerEvent {
    executor_seq: i64,
    kind: EventKind,
    text: String,
}

#[derive(Serialize)]
struct EventReceipt {
    sequence: i64,
}

async fn event(
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<RunnerEvent>, JsonRejection>,
) -> Result<Json<EventReceipt>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        authorize(db, &headers)?;
        let _guard = db.ai_guard()?;
        let op = Operation::by_lease(db, &lease)?;
        require_running(&op)?;
        op.actor(&service, false)?;
        if !(1..=512).contains(&request.executor_seq) || request.text.len() > 8192 {
            return Err(ApiError::invalid("Runner event exceeds sequence or body size limits"));
        }
        let payload = serde_json::json!({"text":request.text}).to_string();
        let kind = request.kind.as_str();
        let connection = db.connection()?;
        let existing: Option<(i64, String, String)> = connection.query_row(
            "SELECT seq, kind, payload FROM ai_events WHERE operation_id = ?1 AND lease_id = ?2 AND executor_seq = ?3",
            params![op.view.id, lease, request.executor_seq],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        if let Some((sequence, prior_kind, prior_payload)) = existing {
            if prior_kind != kind || prior_payload != payload {
                return Err(ApiError::new(StatusCode::CONFLICT, "runner_event_changed", "An event with this sequence already exists"));
            }
            return Ok(Json(EventReceipt { sequence }));
        }
        connection.execute(
            "INSERT INTO ai_events (operation_id, lease_id, executor_seq, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![op.view.id, lease, request.executor_seq, kind, payload],
        )?;
        Ok(Json(EventReceipt { sequence: connection.last_insert_rowid() }))
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    text: String,
}

async fn fail(
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<Failure>, JsonRejection>,
) -> Result<Json<OperationView>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        authorize(db, &headers)?;
        let _guard = db.ai_guard()?;
        let mut op = Operation::by_lease(db, &lease)?;
        op.actor(&service, false)?;
        let text = request.text.trim();
        if text.is_empty() || text.len() > 1024 {
            return Err(ApiError::invalid(
                "Runner failure needs a short description",
            ));
        }
        if op.view.status == OperationStatus::Failed && op.view.answer.as_deref() == Some(text) {
            return Ok(Json(op.view));
        }
        require_running(&op)?;
        op.view.answer = Some(text.to_owned());
        op.view.sources.clone_from(&op.delivered);
        op.settle(db, OperationStatus::Failed)?;
        Ok(Json(op.view))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRequest {
    document_id: String,
    #[serde(default)]
    outline: bool,
    #[serde(default)]
    full: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceData {
    source: SourceReference,
    markdown: String,
}

async fn source(
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<SourceRequest>, JsonRejection>,
) -> Result<Json<SourceData>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        authorize(db, &headers)?;
        let _guard = db.ai_guard()?;
        let mut op = Operation::by_lease(db, &lease)?;
        require_running(&op)?;
        let account = op.actor(&service, false)?;
        let (workspace, path) = db.document_path(&request.document_id)?;
        if workspace != op.view.workspace_id {
            return Err(ApiError::not_found());
        }
        let (path, markdown, revision) = if request.outline {
            let outline = service.get_outline(&account, &request.document_id)?;
            let revision = outline.revision.ok_or_else(ApiError::not_found)?;
            (
                super::documents::outline_path(&path),
                outline.markdown,
                revision,
            )
        } else {
            let snapshot = service.get(&account, &request.document_id)?;
            (path, snapshot.markdown, snapshot.revision)
        };
        let context = op.input.as_ref().and_then(|input| {
            input
                .context
                .iter()
                .find(|item| item.document_id == request.document_id && !request.outline)
        });
        let (markdown, block_id, from, to) = if let Some(context) = context {
            if context
                .revision
                .as_deref()
                .is_some_and(|expected| expected != revision)
            {
                return Err(ApiError::conflict(Some(revision)));
            }
            if request.full {
                (markdown, None, None, None)
            } else {
                (
                    select(&markdown, context)?,
                    context.block_id.clone(),
                    context.from,
                    context.to,
                )
            }
        } else {
            (markdown, None, None, None)
        };
        if let Some(source) = op.delivered.iter().find(|source| {
            source.path == path
                && source.revision == revision
                && source.block_id == block_id
                && source.from == from
                && source.to == to
        }) {
            return Ok(Json(SourceData {
                source: source.clone(),
                markdown,
            }));
        }
        if op.delivered.len() >= MAX_SOURCES {
            return Err(ApiError::invalid(
                "This operation has read its maximum number of sources",
            ));
        }
        let source = SourceReference {
            id: Uuid::new_v4().to_string(),
            document_id: request.document_id,
            path,
            revision,
            block_id,
            from,
            to,
        };
        op.delivered.push(source.clone());
        op.store(db, false)?;
        Ok(Json(SourceData { source, markdown }))
    })
    .await
}

fn select(markdown: &str, context: &ContextRequest) -> Result<String, ApiError> {
    let (from, to) = match (context.from, context.to) {
        (None, None) => return Ok(markdown.to_owned()),
        (Some(from), Some(to)) if from < to && to - from <= 64 * 1024 => (from, to),
        _ => return Err(ApiError::invalid("Invalid source selection range")),
    };
    let mut utf16 = 0;
    let mut start = None;
    for (offset, unit) in markdown.char_indices() {
        if utf16 == from {
            start = Some(offset);
        }
        if utf16 == to {
            return start
                .map(|start| markdown[start..offset].to_owned())
                .ok_or_else(invalid_selection);
        }
        utf16 += unit.len_utf16() as u32;
    }
    if utf16 == to {
        if let Some(start) = start {
            return Ok(markdown[start..].to_owned());
        }
    }
    Err(invalid_selection())
}

fn invalid_selection() -> ApiError {
    ApiError::invalid("Source selection is outside the Markdown character boundaries")
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRequest {
    answer: String,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    edits: Vec<EditRequest>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditRequest {
    path: String,
    #[serde(default, deserialize_with = "present_revision")]
    base_revision: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_revision")]
    markdown: Option<Option<String>>,
}

async fn result(
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<ResultRequest>, JsonRejection>,
) -> Result<Json<OperationView>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        authorize(db, &headers)?;
        let _guard = db.ai_guard()?;
        let mut op = Operation::by_lease(db, &lease)?;
        let account = op.actor(&service, op.view.mode == Mode::Edit)?;
        let fingerprint = sha256_hex(&serde_json::to_vec(&request).map_err(ApiError::internal)?);
        if let Some(prior) = &op.result_fingerprint {
            if prior != &fingerprint {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "result_changed",
                    "This lease already submitted a different result",
                ));
            }
            if op.view.status == OperationStatus::Running && op.accepted.is_some() {
                op.apply_result(&service, &account)?;
            }
            if op.view.status == OperationStatus::Conflict {
                return Err(ApiError::conflict(None));
            }
            return Ok(Json(op.view));
        }
        require_running(&op)?;
        let accepted = verify_result(&op, request)?;
        let paths = accepted
            .edits
            .iter()
            .filter(|edit| edit.markdown.is_none())
            .map(|edit| edit.path.clone())
            .collect::<Vec<_>>();
        op.result_fingerprint = Some(fingerprint);
        op.input = None;
        if !paths.is_empty() {
            op.view.answer = Some(accepted.answer.clone());
            op.view.sources.clone_from(&accepted.sources);
            op.view.confirmation = Some(Confirmation {
                id: Uuid::new_v4().to_string(),
                paths,
            });
            op.view.status = OperationStatus::NeedsConfirmation;
        }
        op.accepted = Some(accepted);
        let needs_confirmation = op.view.status == OperationStatus::NeedsConfirmation;
        op.store(db, needs_confirmation)?;
        if !needs_confirmation {
            op.apply_result(&service, &account)?;
        }
        Ok(Json(op.view))
    })
    .await
}

fn verify_result(op: &Operation, request: ResultRequest) -> Result<AcceptedResult, ApiError> {
    if request.answer.len() > 256 * 1024 || request.source_ids.len() > MAX_SOURCES {
        return Err(ApiError::invalid("Executor result is too large"));
    }
    if op.view.mode == Mode::Chat && !request.edits.is_empty() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "chat_is_read_only",
            "A chat operation cannot modify files",
        ));
    }
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    for id in &request.source_ids {
        if !seen.insert(id.as_str()) {
            continue;
        }
        let source = op
            .delivered
            .iter()
            .find(|source| &source.id == id)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unverified_source",
                    "The runner did not read this source for the current lease",
                )
            })?;
        sources.push(source.clone());
    }
    sources.extend(
        op.delivered
            .iter()
            .filter(|source| !seen.contains(source.id.as_str()))
            .cloned(),
    );
    let mut edits = request
        .edits
        .into_iter()
        .map(|edit| {
            let base_revision =
                content_precondition(edit.base_revision.as_ref())?.map(str::to_owned);
            if let Some(revision) = &base_revision {
                if !op.delivered.iter().any(|source| {
                    source.path == edit.path
                        && &source.revision == revision
                        && source.from.is_none()
                }) {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "unverified_revision",
                        "Read the whole current file before modifying it",
                    ));
                }
            }
            let markdown = edit.markdown.ok_or_else(|| {
                ApiError::invalid("An edit requires Markdown or an explicit null deletion")
            })?;
            if markdown.is_none() && base_revision.is_none() {
                return Err(ApiError::invalid("Deleting a file requires its revision"));
            }
            Ok(MutationEdit {
                path: edit.path,
                base_revision,
                markdown,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    if !edits.is_empty() {
        edits.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        mutations::validate_edits(&edits)?;
    }
    Ok(AcceptedResult {
        answer: request.answer,
        sources,
        edits,
    })
}
