use std::{collections::BTreeSet, sync::Arc};

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use tokio_stream::Stream;
use uuid::Uuid;

use crate::revisions::read;

use super::{
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::{body, run, state, DocumentService},
    mutations::{self, MutationContext, MutationEdit, MutationReceipt},
};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Mode {
    Chat,
    Edit,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum OperationStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Conflict,
    NeedsConfirmation,
    Canceled,
}

impl OperationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Conflict => "conflict",
            Self::NeedsConfirmation => "needs_confirmation",
            Self::Canceled => "canceled",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskInput {
    pub workspace_id: String,
    pub document_id: Option<String>,
    pub mode: Mode,
    pub prompt: String,
    #[serde(default)]
    pub context: Vec<ContextRequest>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContextRequest {
    pub document_id: String,
    pub revision: Option<String>,
    pub from: Option<u32>,
    pub to: Option<u32>,
    pub block_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceReference {
    pub id: String,
    pub document_id: String,
    pub path: String,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OperationView {
    pub id: String,
    pub workspace_id: String,
    pub document_id: Option<String>,
    pub mode: Mode,
    pub status: OperationStatus,
    pub answer: Option<String>,
    pub sources: Vec<SourceReference>,
    pub commit_id: Option<String>,
    pub confirmation: Option<Confirmation>,
    pub undo_commit_id: Option<String>,
    pub changes: Vec<mutations::FileChange>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Confirmation {
    pub id: String,
    pub paths: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lease {
    pub id: String,
    pub expires_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AcceptedResult {
    pub answer: String,
    pub sources: Vec<SourceReference>,
    pub edits: Vec<MutationEdit>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Operation {
    pub view: OperationView,
    owner: String,
    credential_version: Option<String>,
    pub input: Option<TaskInput>,
    pub lease: Option<Lease>,
    pub delivered: Vec<SourceReference>,
    pub accepted: Option<AcceptedResult>,
    pub result_fingerprint: Option<String>,
    undo_id: String,
}

impl Operation {
    pub(super) fn get(db: &Metadata, id: &str) -> Result<Self, ApiError> {
        Self::find(db, "id", id)
    }

    pub(super) fn by_lease(db: &Metadata, id: &str) -> Result<Self, ApiError> {
        Self::find(db, "lease_id", id)
    }

    fn find(db: &Metadata, field: &str, value: &str) -> Result<Self, ApiError> {
        let json: String = db
            .connection()?
            .query_row(
                &format!("SELECT entry FROM ai_operations WHERE {field} = ?1"),
                [value],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(ApiError::not_found)?;
        serde_json::from_str(&json).map_err(ApiError::internal)
    }

    pub(super) fn claimable(db: &Metadata, now: i64) -> Result<Vec<Self>, ApiError> {
        let connection = db.connection()?;
        let mut query = connection.prepare(
            "SELECT entry FROM ai_operations WHERE status = 'queued'
             OR (status = 'running' AND expires_at <= ?1) ORDER BY rowid LIMIT 32",
        )?;
        let entries = query
            .query_map([now], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        entries
            .iter()
            .map(|entry| serde_json::from_str(entry).map_err(ApiError::internal))
            .collect()
    }

    pub(super) fn store(&self, db: &Metadata, emit: bool) -> Result<(), ApiError> {
        let mut connection = db.connection()?;
        let tx = connection.transaction()?;
        let entry = serde_json::to_string(self).map_err(ApiError::internal)?;
        tx.execute(
            "INSERT INTO ai_operations (id, workspace_id, status, lease_id, expires_at, entry)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, lease_id = excluded.lease_id,
                 expires_at = excluded.expires_at, entry = excluded.entry",
            params![
                self.view.id,
                self.view.workspace_id,
                self.view.status.as_str(),
                self.lease.as_ref().map(|lease| lease.id.as_str()),
                self.lease.as_ref().map(|lease| lease.expires_at),
                entry
            ],
        )?;
        if emit {
            let payload = serde_json::to_string(&self.view).map_err(ApiError::internal)?;
            tx.execute(
                "INSERT INTO ai_events (operation_id, kind, payload) VALUES (?1, 'operation', ?2)",
                params![self.view.id, payload],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn actor(
        &self,
        service: &DocumentService,
        write: bool,
    ) -> Result<Account, ApiError> {
        let space = service.metadata.space_id(&self.view.workspace_id)?;
        let account = Account::from_bound_identity(
            &service.spaces,
            &self.owner,
            self.credential_version.as_deref(),
            BTreeSet::from([space]),
        )?;
        service.scope(&account, &self.view.workspace_id, write)?;
        Ok(account)
    }

    fn ensure_owner(
        &self,
        service: &DocumentService,
        account: &Account,
        write: bool,
    ) -> Result<(), ApiError> {
        if self.owner != account.username() {
            return Err(ApiError::not_found());
        }
        service.scope(account, &self.view.workspace_id, write)?;
        Ok(())
    }

    pub(super) fn settle(
        &mut self,
        db: &Metadata,
        status: OperationStatus,
    ) -> Result<(), ApiError> {
        self.view.status = status;
        self.input = None;
        self.accepted = None;
        self.delivered.clear();
        self.view.confirmation = None;
        self.store(db, true)
    }

    pub(super) fn apply_result(
        &mut self,
        service: &DocumentService,
        account: &Account,
    ) -> Result<(), ApiError> {
        let accepted = self.accepted.as_ref().expect("accepted AI result");
        if !accepted.edits.is_empty() {
            let result = apply_edits(
                service,
                account,
                &self.view.workspace_id,
                &self.view.id,
                accepted.edits.clone(),
            );
            match result {
                Ok(receipt) => {
                    self.view.commit_id = Some(receipt.commit_id);
                    self.view.changes = receipt.changes;
                }
                Err(error) if error.status() == StatusCode::CONFLICT => {
                    self.settle(&service.metadata, OperationStatus::Conflict)?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        self.view.answer = Some(accepted.answer.clone());
        self.view.sources.clone_from(&accepted.sources);
        self.settle(&service.metadata, OperationStatus::Succeeded)
    }
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/operations", get(list).post(create))
        .route("/ai/operations/{operation}", get(get_operation))
        .route("/ai/operations/{operation}/events", get(events))
        .route("/ai/operations/{operation}/diff", get(diff))
        .route("/ai/operations/{operation}/confirm", post(confirm))
        .route("/ai/operations/{operation}/undo", post(undo))
        .merge(super::ai_runner::routes())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationList {
    workspace_id: String,
    document_id: Option<String>,
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    query: Result<Query<OperationList>, QueryRejection>,
) -> Result<Json<Vec<OperationView>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("A workspaceId is required"))?;
    run(move || {
        service.scope(&account, &query.workspace_id, false)?;
        if let Some(document) = &query.document_id {
            if service.metadata.document_path(document)?.0 != query.workspace_id {
                return Err(ApiError::not_found());
            }
        }
        let db = service.metadata.connection()?;
        let mut list = db.prepare(
            "SELECT entry FROM ai_operations WHERE workspace_id = ?1
               AND json_extract(entry, '$.owner') = ?2
               AND json_extract(entry, '$.view.documentId') IS ?3
             ORDER BY rowid DESC LIMIT 50",
        )?;
        let entries = list
            .query_map(
                params![query.workspace_id, account.username(), query.document_id],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let views = entries
            .iter()
            .rev()
            .map(|entry| {
                serde_json::from_str::<Operation>(entry)
                    .map(|op| op.view)
                    .map_err(ApiError::internal)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Json(views))
    })
    .await
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<TaskInput>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationView>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || {
        if input.prompt.trim().is_empty()
            || input.prompt.len() > 16 * 1024
            || input.context.len() > 24
        {
            return Err(ApiError::invalid(
                "Expected a prompt between 1 and 16,384 bytes and at most 24 references",
            ));
        }
        if input.context.iter().any(|context| {
            context.from.is_some() != context.to.is_some()
                || (context.from.is_some() && context.revision.is_none())
        }) {
            return Err(ApiError::invalid(
                "A source selection requires a range and its content revision",
            ));
        }
        let (_, actor) = service.scope(&account, &input.workspace_id, input.mode == Mode::Edit)?;
        for id in input
            .document_id
            .iter()
            .chain(input.context.iter().map(|entry| &entry.document_id))
        {
            let (workspace, _) = service.metadata.document_path(id)?;
            if workspace != input.workspace_id {
                return Err(ApiError::not_found());
            }
        }
        let op = Operation {
            view: OperationView {
                id: Uuid::new_v4().to_string(),
                workspace_id: input.workspace_id.clone(),
                document_id: input.document_id.clone(),
                mode: input.mode,
                status: OperationStatus::Queued,
                answer: None,
                sources: Vec::new(),
                commit_id: None,
                confirmation: None,
                undo_commit_id: None,
                changes: Vec::new(),
            },
            owner: account.username().to_owned(),
            credential_version: actor.credential_version,
            input: Some(input),
            lease: None,
            delivered: Vec::new(),
            accepted: None,
            result_fingerprint: None,
            undo_id: Uuid::new_v4().to_string(),
        };
        op.store(&service.metadata, true)?;
        Ok((StatusCode::ACCEPTED, Json(op.view)))
    })
    .await
}

async fn get_operation(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<OperationView>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, false)?;
        Ok(Json(op.view))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmInput {
    confirmation_id: String,
}

async fn confirm(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<ConfirmInput>, JsonRejection>,
) -> Result<Json<OperationView>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, true)?;
        if op.view.status != OperationStatus::NeedsConfirmation
            || !op
                .view
                .confirmation
                .as_ref()
                .is_some_and(|proposal| proposal.id == request.confirmation_id)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "confirmation_invalid",
                "The requested confirmation is no longer valid",
            ));
        }
        op.apply_result(&service, &account)?;
        Ok(Json(op.view))
    })
    .await
}

async fn undo(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MutationReceipt>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, true)?;
        let Some(commit) = op.view.commit_id.as_deref() else {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "undo_unavailable",
                "There is no committed operation to undo",
            ));
        };
        let (instance, actor) = service.scope(&account, &op.view.workspace_id, true)?;
        let state = state(&instance)?;
        let engine = managed_engine(state)?;
        let result = engine.with_managed_write(|transaction| {
            let mut edits = Vec::with_capacity(op.view.changes.len());
            for change in &op.view.changes {
                let markdown = if let Some(before) = &change.before_revision {
                    let bytes = read::file_at(engine.store(), &change.path, commit, true)
                        .map_err(ApiError::internal)?
                        .ok_or_else(ApiError::not_found)?;
                    if sha256_hex(&bytes) != *before {
                        return Err(ApiError::internal(
                            "Undo source revision does not match its receipt",
                        ));
                    }
                    Some(String::from_utf8(bytes).map_err(ApiError::internal)?)
                } else {
                    None
                };
                edits.push(MutationEdit {
                    path: change.path.clone(),
                    base_revision: change.revision.clone(),
                    markdown,
                });
            }
            MutationContext {
                metadata: &service.metadata,
                state,
                actor: &actor,
                workspace: &op.view.workspace_id,
                account: account.username(),
                operation: &op.undo_id,
            }
            .apply(transaction, edits)
        })?;
        if op.view.undo_commit_id.as_deref() != Some(&result.commit_id) {
            op.view.undo_commit_id = Some(result.commit_id.clone());
            op.store(&service.metadata, true)?;
        }
        Ok(Json(result))
    })
    .await
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationDiff {
    commit_id: String,
    path: String,
    diff: String,
}

async fn diff(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    query: Result<Query<DiffQuery>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Json<OperationDiff>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("An affected path is required"))?;
    run(move || {
        let op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, false)?;
        let commit_id = op.view.commit_id.ok_or_else(ApiError::not_found)?;
        if !op
            .view
            .changes
            .iter()
            .any(|change| change.path == query.path)
        {
            return Err(ApiError::not_found());
        }
        let (instance, _) = service.scope(&account, &op.view.workspace_id, false)?;
        let state = state(&instance)?;
        let _read = super::documents::product_read(state)?;
        let store = managed_engine(state)?.store();
        let diff = read::file_diff(store, &query.path, &commit_id, false)
            .map_err(ApiError::internal)?
            .ok_or_else(ApiError::not_found)?;
        if diff.len() > super::documents::MARKDOWN_LIMIT * 3 {
            return Err(super::documents::too_large());
        }
        Ok(Json(OperationDiff {
            commit_id,
            path: query.path,
            diff,
        }))
    })
    .await
}

fn managed_engine(
    state: &crate::state::ServerState,
) -> Result<&crate::revisions::RevisionEngine, ApiError> {
    state
        .revisions
        .as_deref()
        .filter(|engine| engine.store().auto_commit_allowed())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "revisions_unavailable",
                "This operation requires managed versions",
            )
        })
}

fn apply_edits(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    operation: &str,
    edits: Vec<MutationEdit>,
) -> Result<MutationReceipt, ApiError> {
    let (instance, actor) = service.scope(account, workspace, true)?;
    let state = state(&instance)?;
    managed_engine(state)?.with_managed_write(|transaction| {
        MutationContext {
            metadata: &service.metadata,
            state,
            actor: &actor,
            workspace,
            account: account.username(),
            operation,
        }
        .apply(transaction, edits)
    })
}

async fn events(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default()
        .max(0);
    run(move || {
        let op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, false)?;
        let connection = service.metadata.connection()?;
        let mut query = connection.prepare(
            "SELECT seq, kind, payload FROM ai_events WHERE operation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT 256",
        )?;
        let rows = query.query_map(params![id, after], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Sse::new(tokio_stream::iter(rows.into_iter().map(|(seq, kind, payload)| {
            Ok(Event::default().id(seq.to_string()).event(kind).data(payload))
        }))))
    }).await
}
