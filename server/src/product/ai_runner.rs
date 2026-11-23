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
    Extension, Json, Router,
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
    ai_managed::{self, Protocol},
    ai_probes::{self, ProbeAction},
    audit,
    content_policy::{self, Action},
    contract::{content_precondition, present_revision, ApiError, DocumentSummary},
    db::Metadata,
    documents::{body, run, DocumentList, DocumentService},
    mutations::{self, MutationEdit},
    security_levels::SecurityLevel,
    workspace,
};

const LEASE_SECS: i64 = 180;
const MAX_SOURCES: usize = 64;

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    let common = Router::new()
        .route("/claims", post(claim))
        .route("/claims/{lease}/sources", post(source))
        .route("/claims/{lease}/documents", get(documents))
        .route("/claims/{lease}/events", post(event));
    let legacy = common
        .clone()
        .route("/claims/{lease}/renew", post(renew))
        .route("/claims/{lease}/fail", post(fail))
        .route("/claims/{lease}/result", put(result))
        .layer(Extension(Protocol::Legacy));
    let managed = common
        .route("/claims/{lease}/workspaces", get(workspaces))
        .route("/claims/{lease}/renew", post(managed_renew))
        .route("/claims/{lease}/fail", post(managed_fail))
        .route("/claims/{lease}/result", put(managed_result))
        .layer(Extension(Protocol::Managed));
    Router::new()
        .nest("/ai/runner", legacy)
        .nest("/ai/runner/v2", managed)
        .merge(ai_managed::routes())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claimed {
    operation_id: String,
    lease_id: String,
    expires_at: i64,
    input: ClaimInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selection: Option<super::ai_configuration::LeasedSelection>,
}

#[derive(Serialize)]
struct ClaimInput {
    #[serde(flatten)]
    task: TaskInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    materials: Option<Vec<super::ai_materials::Selected>>,
    #[serde(flatten)]
    conversation: Option<super::ai_conversations::ClaimHistory>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn authorize_legacy(db: &Metadata, headers: &HeaderMap) -> Result<(), ApiError> {
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

fn authenticate(
    service: &DocumentService,
    headers: &HeaderMap,
    protocol: Protocol,
) -> Result<Option<String>, ApiError> {
    match protocol {
        Protocol::Legacy => {
            authorize_legacy(&service.metadata, headers)?;
            Ok(None)
        }
        Protocol::Managed => ai_managed::instance(service, headers).map(Some),
    }
}

fn checked_lease(
    service: &DocumentService,
    headers: &HeaderMap,
    id: &str,
    protocol: Protocol,
) -> Result<Operation, ApiError> {
    let instance = authenticate(service, headers, protocol)?;
    let mut op = Operation::by_lease(&service.metadata, id)?;
    ai_managed::check_lease(service, &mut op, protocol, instance.as_deref())?;
    Ok(op)
}

async fn claim(
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    run(move || {
        let db = &service.metadata;
        let instance = authenticate(&service, &headers, protocol)?;
        let _guard = db.ai_guard()?;
        let now = now();
        if !ai_managed::enabled(&service)? {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        if let Some(id) = &instance {
            let conn = db.connection()?;
            if let Some(probe) = ai_probes::claim(&service, &conn, id, now)? {
                return Ok(Json(probe).into_response());
            }
        }
        for mut op in Operation::claimable(db, now, protocol)? {
            if op.recover_committed(&service)? {
                continue;
            }
            if let Err(error) = ai_managed::check_operation(&service, &mut op) {
                if error.status() == StatusCode::CONFLICT {
                    continue;
                }
                return Err(error);
            }
            if protocol == Protocol::Managed
                && op.view.status == OperationStatus::Queued
                && op.queued_at <= now - 120
            {
                op.view.answer = Some("等待执行器超时，请重试。".into());
                op.settle(db, OperationStatus::Failed)?;
                continue;
            }
            // Keep the membership snapshot valid until the history and lease are issued.
            // Resuming an accepted action acquires the workspace lock inside its own domain service.
            let _workspace_guard = if op.accepted.is_none() {
                Some(db.workspace_guard()?)
            } else {
                None
            };
            let write = op.view.mode == Mode::Edit;
            let account = match op.actor(&service, write) {
                Ok(account) => account,
                Err(error)
                    if matches!(
                        error.status(),
                        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
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
            let input = ClaimInput {
                conversation: super::ai_conversations::claim_history(
                    &service,
                    &account,
                    &mut op,
                    input.prompt.len(),
                )?,
                materials: if protocol == Protocol::Managed {
                    Some(super::ai_materials::selected(db, &op.view.id)?)
                } else {
                    None
                },
                task: input,
            };
            // The captured history may have added transitive workspace dependencies.
            op.actor(&service, write)?;
            let selection = op
                .view
                .selection
                .as_ref()
                .map(|choice| super::ai_configuration::leased_selection(&*db.connection()?, choice))
                .transpose()?;
            let lease_id = Uuid::new_v4().to_string();
            let expires_at = now + LEASE_SECS;
            op.lease = Some(Lease {
                id: lease_id.clone(),
                expires_at,
                instance_id: instance.clone(),
                provider_issued: false,
            });
            op.view.status = OperationStatus::Running;
            op.delivered.clear();
            op.store(db, true)?;
            return Ok(Json(Claimed {
                task_kind: instance.as_ref().map(|_| "chat"),
                selection,
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

pub(super) fn require_running(op: &Operation) -> Result<(), ApiError> {
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Discovery {
    q: Option<String>,
    workspace_id: Option<String>,
}

fn read_workspace<'a>(op: &'a Operation, requested: Option<&'a str>) -> Result<&'a str, ApiError> {
    match (op.is_global(), requested) {
        (true, Some(ws)) if !ws.is_empty() => Ok(ws),
        (true, _) => Err(ApiError::invalid("Global reads require a workspaceId")),
        (false, Some(ws)) if ws != op.view.workspace_id => Err(ApiError::not_found()),
        _ => Ok(&op.view.workspace_id),
    }
}

async fn workspaces(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut op = checked_lease(&service,&headers,&id,Protocol::Managed)?;
        require_running(&op)?;
        if !op.is_global() { return Err(ApiError::not_found()); }
        let account = op.actor(&service,false)?;
        let _workspace_guard = service.metadata.workspace_guard()?;
        op.ensure_owner(&service,&account,false)?;
        let rows = service.workspaces_under_guard(&account)?;
        let mut result = Vec::with_capacity(rows.len());
        for w in rows {
            op.workspace_dependencies.insert(w.id.clone());
            result.push(serde_json::json!({"id":w.id,"name":w.name,"canWrite":w.can_write,"canManage":w.can_manage}));
        }
        op.store(&service.metadata,false)?;
        Ok(Json(result))
    }).await
}

async fn documents(
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    Query(discovery): Query<Discovery>,
    headers: HeaderMap,
) -> Result<Json<Vec<DocumentSummary>>, ApiError> {
    let lookup = service.clone();
    let id = lease.clone();
    let copy = headers.clone();
    let (account, workspace) = run(move || {
        let _guard = lookup.metadata.ai_guard()?;
        let op = checked_lease(&lookup, &copy, &id, protocol)?;
        require_running(&op)?;
        let workspace = read_workspace(&op, discovery.workspace_id.as_deref())?.to_owned();
        let account = op.actor(&lookup, false)?;
        lookup.scope(&account, &workspace, false)?;
        Ok((account, workspace))
    })
    .await?;
    let hits = if let Some(q) = discovery.q {
        let hits = super::search::find_documents(
            service.clone(),
            account,
            workspace.clone(),
            q,
            &HeaderMap::new(),
        )
        .await?;
        Some(hits.into_iter().map(|hit| hit.document).collect())
    } else {
        None
    };
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut op = checked_lease(&service, &headers, &lease, protocol)?;
        require_running(&op)?;
        let _workspace_guard = service.metadata.workspace_guard()?;
        let account = op.actor(&service, false)?;
        service.scope(&account, &workspace, false)?;
        let docs = match hits {
            Some(hits) => hits,
            None => service.list(
                &account,
                &workspace,
                DocumentList {
                    after: None,
                    limit: Some(100),
                },
            )?,
        };
        if op.is_global() {
            op.workspace_dependencies.insert(workspace);
            op.store(&service.metadata, false)?;
        }
        Ok(Json(docs))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Renewal {
    expires_at: i64,
}

async fn renew(
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Renewal>, ApiError> {
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        let mut op = checked_lease(&service, &headers, &lease, protocol)?;
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
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<RunnerEvent>, JsonRejection>,
) -> Result<Json<EventReceipt>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        let op = checked_lease(&service,&headers,&lease,protocol)?;
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
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<Failure>, JsonRejection>,
) -> Result<Json<OperationView>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        let mut op = checked_lease(&service, &headers, &lease, protocol)?;
        op.actor(&service, false)?;
        if op.recover_committed(&service)? {
            op.actor(&service, false)?;
            return Ok(Json(op.view));
        }
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
    workspace_id: Option<String>,
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
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<SourceRequest>, JsonRejection>,
) -> Result<Json<SourceData>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        let mut op = checked_lease(&service, &headers, &lease, protocol)?;
        require_running(&op)?;
        let _workspace_guard = db.workspace_guard()?;
        let account = op.actor(&service, false)?;
        let workspace = read_workspace(&op, request.workspace_id.as_deref())?.to_owned();
        let (instance, _) = service.scope(&account, &workspace, false)?;
        let (path, markdown, revision) = if request.outline {
            let path = service.path_in(&workspace, &request.document_id)?;
            let outline = service.get_outline_in(&account, &workspace, &request.document_id)?;
            let revision = outline.revision.ok_or_else(ApiError::not_found)?;
            (
                super::documents::outline_path(&path),
                outline.markdown,
                revision,
            )
        } else {
            let snapshot = service.get_in(&account, &workspace, &request.document_id)?;
            (snapshot.path, snapshot.markdown, snapshot.revision)
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
        let level = workspace::info(&service.metadata, &workspace)?.security_level;
        if matches!(level, SecurityLevel::Confidential | SecurityLevel::Secret) {
            audit::policy_block(
                &service.metadata,
                Some(account.username()),
                &workspace,
                "ai",
                "external_ai_disabled",
            )?;
            return Err(ApiError::policy_blocked("external_ai_disabled"));
        }
        let inspection = content_policy::inspect(&markdown, level);
        let markdown = match inspection.action {
            Action::Allow => markdown,
            Action::Deny => {
                let rule = inspection.blocking_rule.unwrap_or("content_policy");
                audit::policy_block(
                    &service.metadata,
                    Some(account.username()),
                    &workspace,
                    "ai",
                    rule,
                )?;
                return Err(ApiError::policy_blocked(rule));
            }
            Action::Redact => {
                if op
                    .input
                    .as_ref()
                    .is_some_and(|input| input.mode == Mode::Edit)
                {
                    audit::policy_block(
                        &service.metadata,
                        Some(account.username()),
                        &workspace,
                        "ai",
                        "external_ai_redacted_edit",
                    )?;
                    return Err(ApiError::policy_blocked("external_ai_redacted_edit"));
                }
                inspection.redacted
            }
        };
        if let Some(source) = op.delivered.iter().find(|source| {
            source.document_id == request.document_id
                && source
                    .workspace_id
                    .as_deref()
                    .is_none_or(|id| id == workspace)
                && source.path == path
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
            workspace_id: Some(workspace.clone()),
            workspace_name: Some(instance.config.name.clone()),
            material: None,
            id: Uuid::new_v4().to_string(),
            document_id: request.document_id,
            path,
            revision,
            block_id,
            from,
            to,
        };
        let mut conn = db.connection()?;
        let tx = conn.transaction()?;
        if protocol == Protocol::Managed {
            super::ai_materials::charge_read(&tx, &op, markdown.len())?;
        }
        if op.is_global() {
            op.workspace_dependencies.insert(workspace);
        }
        op.delivered.push(source.clone());
        op.store_in(&tx, false)?;
        tx.commit()?;
        Ok(Json(SourceData { source, markdown }))
    })
    .await
}

pub(super) fn select(markdown: &str, context: &ContextRequest) -> Result<String, ApiError> {
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum GlobalAction {
    Management(super::ai_space_management::Action),
    Transfer(super::ai_transfer::Request),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<GlobalAction>,
    answer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_workspace_id: Option<String>,
    #[serde(default)]
    source_ids: Vec<String>,
    #[serde(default)]
    edits: Vec<EditRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reorganization: Option<super::ai_reorganization::ReorganizationRequest>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_id: Option<String>,
    #[serde(default, deserialize_with = "present_revision")]
    base_revision: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_revision")]
    markdown: Option<Option<String>>,
}

async fn result(
    Extension(protocol): Extension<Protocol>,
    State(service): State<Arc<DocumentService>>,
    Path(lease): Path<String>,
    headers: HeaderMap,
    request: Result<Json<ResultRequest>, JsonRejection>,
) -> Result<Json<OperationView>, ApiError> {
    let request = body(request)?;
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        let mut op = checked_lease(&service, &headers, &lease, protocol)?;
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
            if op.view.status == OperationStatus::Running
                && op.accepted.is_some()
                && !op.recover_committed(&service)?
            {
                op.apply_result(&service, &account)?;
            }
            op.actor(&service, false)?;
            if op.view.status == OperationStatus::Conflict {
                return Err(ApiError::conflict(None));
            }
            return Ok(Json(op.view));
        }
        require_running(&op)?;
        if request.reorganization.is_some()
            && (op.view.mode != Mode::Edit || !request.edits.is_empty())
        {
            return Err(ApiError::invalid(
                "Reorganization requires a dedicated edit operation",
            ));
        }
        if request.target_workspace_id.is_some() != (op.is_global() && !request.edits.is_empty())
            || (op.is_global()
                && (request.reorganization.is_some()
                    || request.edits.iter().any(|e| e.markdown == Some(None))))
        {
            return Err(ApiError::invalid(
                "Global document edits require one targetWorkspaceId and Markdown",
            ));
        }
        if let Some(target) = &request.target_workspace_id {
            service.scope(&account, target, true)?;
            op.view.target_workspace_id = Some(target.clone());
            op.workspace_dependencies.insert(target.clone());
        }
        let action = request.action.clone();
        if action.is_some()
            && (!op.is_global()
                || op.protocol != Protocol::Managed
                || op.view.mode != Mode::Edit
                || !request.edits.is_empty()
                || request.reorganization.is_some())
        {
            return Err(ApiError::invalid(
                "A workspace action requires a dedicated global edit",
            ));
        }
        let reorganization = request.reorganization.clone();
        let accepted = {
            let _workspace_guard = service.metadata.workspace_guard()?;
            let accepted = verify_result(&service, &op, request)?;
            if let Some(ws) = &op.view.target_workspace_id {
                service.scope(&account, ws, true)?;
                op.write_targets = super::ai_reorganization::global_write_targets(
                    db,
                    ws,
                    &accepted.edits,
                    &op.delivered,
                )?;
            }
            accepted
        };
        let paths = accepted
            .edits
            .iter()
            .filter(|edit| edit.markdown.is_none())
            .map(|edit| edit.path.clone())
            .collect::<Vec<_>>();
        op.result_fingerprint = Some(fingerprint);
        op.input = None;
        match action {
            Some(GlobalAction::Transfer(request)) => {
                op.workspace_dependencies
                    .insert(request.source_workspace_id.clone());
                op.workspace_dependencies
                    .insert(request.target_workspace_id.clone());
                op.accepted = Some(accepted);
                super::ai_transfer::preview(&service, &account, &mut op, request)?;
                return Ok(Json(op.view));
            }
            Some(GlobalAction::Management(action)) => {
                if let Some(id) = action.workspace() {
                    op.workspace_dependencies.insert(id.to_owned());
                }
                op.management_action = Some(action);
            }
            None => (),
        }
        if let Some(request) = reorganization {
            op.accepted = Some(accepted);
            super::ai_reorganization::preview(&service, &account, &mut op, request)?;
            return Ok(Json(op.view));
        }
        if !paths.is_empty() {
            op.view.answer = Some(accepted.answer.clone());
            op.view.sources.clone_from(&accepted.sources);
            op.view.confirmation = Some(Confirmation {
                id: Uuid::new_v4().to_string(),
                paths,
                plan: None,
                transfer: None,
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

fn verify_result(
    service: &DocumentService,
    op: &Operation,
    request: ResultRequest,
) -> Result<AcceptedResult, ApiError> {
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
    let mut edits = Vec::new();
    if !request.edits.is_empty() {
        if request.edits.iter().any(|e| e.markdown == Some(None)) {
            // Preserve the legacy protocol's explicit deletion proposals.
            if request.edits.len() > 32 {
                return Err(ApiError::invalid("Expected at most 32 edits"));
            }
            for edit in request.edits {
                let base_revision =
                    content_precondition(edit.base_revision.as_ref())?.map(str::to_owned);
                let path = super::ai_reorganization::resolve_path(
                    service,
                    &op.view.workspace_id,
                    edit.path,
                    edit.document_id,
                )?;
                let markdown = edit
                    .markdown
                    .ok_or_else(|| ApiError::invalid("Expected Markdown or explicit deletion"))?;
                if let Some(revision) = &base_revision {
                    super::ai_reorganization::verify_read(op.delivered.iter(), &path, revision)?;
                } else if markdown.is_none() {
                    return Err(ApiError::invalid("Deleting a file requires its revision"));
                }
                edits.push(MutationEdit {
                    path,
                    base_revision,
                    markdown,
                });
            }
            edits.sort_by(|a, b| a.path.cmp(&b.path));
            mutations::validate_edits(&edits)?;
        } else {
            let batch = request
                .edits
                .into_iter()
                .map(|e| {
                    Ok(super::ai_reorganization::WorkspaceEdit {
                        path: e.path,
                        document_id: e.document_id,
                        base_revision: e.base_revision,
                        markdown: e
                            .markdown
                            .flatten()
                            .ok_or_else(|| ApiError::invalid("Expected Markdown"))?,
                    })
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            edits = super::ai_reorganization::resolve_edits(
                service,
                op.view.mutation_workspace(),
                batch,
                (!op.is_global()).then_some(op.delivered.as_slice()),
            )?;
        }
    }
    Ok(AcceptedResult {
        answer: request.answer,
        sources,
        edits,
    })
}

async fn probe_action(
    service: &Arc<DocumentService>,
    headers: &HeaderMap,
    id: &str,
    action: OwnedProbeAction,
) -> Result<Option<serde_json::Value>, ApiError> {
    let service = Arc::clone(service);
    let headers = headers.clone();
    let id = id.to_owned();
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let action = match &action {
            OwnedProbeAction::Renew => ProbeAction::Renew,
            OwnedProbeAction::Finish => ProbeAction::Finish,
            OwnedProbeAction::Fail(code) => ProbeAction::Fail(code),
            OwnedProbeAction::Deny => ProbeAction::Deny,
        };
        ai_managed::probe(&service, &headers, &id, action)
    })
    .await
}
enum OwnedProbeAction {
    Renew,
    Finish,
    Fail(String),
    Deny,
}

async fn managed_renew(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(receipt) = probe_action(&service, &headers, &id, OwnedProbeAction::Renew).await? {
        return Ok(Json(receipt).into_response());
    }
    renew(
        Extension(Protocol::Managed),
        State(service),
        Path(id),
        headers,
    )
    .await
    .map(IntoResponse::into_response)
}
async fn managed_result(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, ApiError> {
    let value = body(request)?;
    let action = if value == serde_json::json!({"ok":true}) {
        OwnedProbeAction::Finish
    } else {
        OwnedProbeAction::Deny
    };
    if let Some(receipt) = probe_action(&service, &headers, &id, action).await? {
        return Ok(Json(receipt).into_response());
    }
    let payload = serde_json::from_value(value)
        .map_err(|_| ApiError::invalid("Expected a valid chat result"))?;
    result(
        Extension(Protocol::Managed),
        State(service),
        Path(id),
        headers,
        Ok(Json(payload)),
    )
    .await
    .map(IntoResponse::into_response)
}
async fn managed_fail(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, ApiError> {
    let value = body(request)?;
    let action = match (
        value.get("code").and_then(|v| v.as_str()),
        value.get("text").and_then(|v| v.as_str()),
    ) {
        (Some(code), Some(_)) => OwnedProbeAction::Fail(code.into()),
        _ => OwnedProbeAction::Deny,
    };
    if let Some(receipt) = probe_action(&service, &headers, &id, action).await? {
        return Ok(Json(receipt).into_response());
    }
    let payload = serde_json::from_value(value)
        .map_err(|_| ApiError::invalid("Expected a valid chat failure"))?;
    fail(
        Extension(Protocol::Managed),
        State(service),
        Path(id),
        headers,
        Ok(Json(payload)),
    )
    .await
    .map(IntoResponse::into_response)
}
