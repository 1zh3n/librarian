use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

use super::{
    ai::{
        validate_scope, ContextRequest, GlobalScope, Mode, Operation, OperationStatus,
        OperationView, TaskInput,
    },
    auth::Account,
    contract::ApiError,
    documents::{body, run, DocumentService},
};

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            document_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ai_conversation_scope ON ai_conversations
            (owner, workspace_id, document_id, created_at, id);
        CREATE TABLE IF NOT EXISTS ai_turns (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
            client_turn_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE REFERENCES ai_operations(id),
            fingerprint TEXT NOT NULL, prompt TEXT NOT NULL, retry_of_turn_id TEXT,
            created_at INTEGER NOT NULL, history_truncated INTEGER NOT NULL DEFAULT 0,
            UNIQUE(conversation_id, client_turn_id)
        );
        CREATE INDEX IF NOT EXISTS ai_turn_order ON ai_turns (conversation_id, created_at, id);
    ")
}

// NULL represents an explicitly global conversation/operation. All preexisting IDs,
// entries and workspace foreign keys are copied verbatim, including historical turns.
pub(super) fn migrate_global_scope(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("
        CREATE TABLE ai_conversations_new (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id),
            document_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            CHECK (workspace_id IS NOT NULL OR document_id IS NULL));
        INSERT INTO ai_conversations_new SELECT * FROM ai_conversations;
        DROP TABLE ai_conversations;
        ALTER TABLE ai_conversations_new RENAME TO ai_conversations;
        CREATE INDEX ai_conversation_scope ON ai_conversations(owner,workspace_id,document_id,created_at,id);
        CREATE TABLE ai_operations_new (
            id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), status TEXT NOT NULL,
            lease_id TEXT UNIQUE, expires_at INTEGER, entry TEXT NOT NULL);
        INSERT INTO ai_operations_new SELECT * FROM ai_operations;
        DROP TABLE ai_operations;
        ALTER TABLE ai_operations_new RENAME TO ai_operations;
        CREATE INDEX ai_operations_queue ON ai_operations(status,expires_at);")
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/conversations", get(list).post(create))
        .route("/ai/conversations/{id}", get(detail).delete(delete))
        .route("/ai/conversations/{id}/turns", get(list_turns).post(send))
        .route("/ai/conversations/{id}/turns/{turn}/cancel", post(cancel))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    scope: Option<GlobalScope>,
    workspace_id: Option<String>,
    document_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConversationView {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<GlobalScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    title: Option<String>,
    pub document_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl ConversationView {
    fn row(row: &Row) -> rusqlite::Result<Self> {
        let workspace_id: Option<String> = row.get(1)?;
        Ok(Self {
            id: row.get(0)?,
            scope: workspace_id.is_none().then_some(GlobalScope::Global),
            workspace_id,
            title: None,
            document_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }
}

pub(super) fn authorize(
    service: &DocumentService,
    account: &Account,
    conversation_id: &str,
) -> Result<ConversationView, ApiError> {
    let conversation = service.metadata.connection()?.query_row(
        "SELECT id, workspace_id, document_id, created_at, updated_at FROM ai_conversations WHERE id = ? AND owner = ?",
        params![conversation_id, account.username()], ConversationView::row
    ).optional()?.ok_or_else(ApiError::not_found)?;
    if let Some(ws) = &conversation.workspace_id {
        service.scope(account, ws, false)?;
    }
    Ok(conversation)
}

fn check_scope(
    service: &DocumentService,
    account: &Account,
    scope: Option<GlobalScope>,
    workspace: Option<&str>,
    document: Option<&str>,
) -> Result<(), ApiError> {
    validate_scope(scope, workspace, document)?;
    let Some(workspace) = workspace else {
        return Ok(());
    };
    service.scope(account, workspace, false)?;
    if let Some(id) = document {
        if service.metadata.document_path(id)?.0 != workspace {
            return Err(ApiError::not_found());
        }
        service.get_in(account, workspace, id)?;
    }
    Ok(())
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<Scope>, JsonRejection>,
) -> Result<(StatusCode, Json<ConversationView>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || {
        check_scope(&service, &account, input.scope, input.workspace_id.as_deref(), input.document_id.as_deref())?;
        let now = Utc::now().timestamp_millis();
        let conversation = ConversationView {
            id: Uuid::new_v4().to_string(),
            scope: input.scope,
            title: None,
            workspace_id: input.workspace_id,
            document_id: input.document_id,
            created_at: now,
            updated_at: now,
        };
        service.metadata.connection()?.execute(
            "INSERT INTO ai_conversations(id, owner, workspace_id, document_id, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?5)",
            params![conversation.id, account.username(), conversation.workspace_id, conversation.document_id, now],
        )?;
        Ok((StatusCode::CREATED, Json(conversation)))
    }).await
}

// Compute readable workspace IDs from the live registry before locking the SQLite connection.
pub(super) fn readable_under_guard(
    service: &DocumentService,
    account: &Account,
    global: bool,
) -> Result<String, ApiError> {
    if !global {
        return Ok("[]".into());
    }
    let ids: Vec<_> = service
        .workspaces_under_guard(account)?
        .into_iter()
        .map(|w| w.id)
        .collect();
    serde_json::to_string(&ids).map_err(ApiError::internal)
}

// Every workspace whose information reached the model must still be readable.
// The same predicate protects list pagination, conversation titles and model history.
pub(super) fn visible(workspaces_param: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM json_each(o.entry,'$.workspaceDependencies') d
        WHERE d.value NOT IN (SELECT value FROM json_each({workspaces_param})))"
    )
}

fn load_title(db: &Connection, c: &mut ConversationView, workspaces: &str) -> Result<(), ApiError> {
    c.title = db
        .query_row(
            &format!(
                "SELECT substr(t.prompt,1,80) FROM ai_turns t
        JOIN ai_operations o ON o.id=t.operation_id WHERE t.conversation_id=?1 AND {}
        ORDER BY t.created_at,t.id LIMIT 1",
                visible("?2")
            ),
            params![c.id, workspaces],
            |r| r.get(0),
        )
        .optional()?;
    Ok(())
}

async fn detail(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ConversationView>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let _workspace_guard = service.metadata.workspace_guard()?;
        let mut c = authorize(&service, &account, &id)?;
        let ids = readable_under_guard(&service, &account, c.scope.is_some())?;
        load_title(&*service.metadata.connection()?, &mut c, &ids)?;
        Ok(Json(c))
    })
    .await
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Pagination {
    cursor: Option<String>,
    limit: Option<usize>,
}

impl Pagination {
    fn bounds(&self, initial: i64) -> Result<(i64, String, usize), ApiError> {
        let limit = self.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err(ApiError::invalid("Expected a page size between 1 and 100"));
        }
        let Some(text) = &self.cursor else {
            return Ok((initial, String::new(), limit));
        };
        let (time, id) = text
            .split_once('.')
            .ok_or_else(|| ApiError::invalid("Invalid page cursor"))?;
        let time = time
            .parse::<i64>()
            .map_err(|_| ApiError::invalid("Invalid page cursor"))?;
        let id = Uuid::parse_str(id).map_err(|_| ApiError::invalid("Invalid page cursor"))?;
        Ok((time, id.to_string(), limit))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    scope: Option<GlobalScope>,
    workspace_id: Option<String>,
    document_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    items: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

fn page<T>(mut items: Vec<T>, limit: usize, cursor: impl FnOnce(&T) -> String) -> Json<Page<T>> {
    let next_cursor = if items.len() > limit {
        items.truncate(limit);
        items.last().map(cursor)
    } else {
        None
    };
    Json(Page { items, next_cursor })
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Page<ConversationView>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let _workspace_guard = service.metadata.workspace_guard()?;
        check_scope(
            &service,
            &account,
            query.scope,
            query.workspace_id.as_deref(),
            query.document_id.as_deref(),
        )?;
        let (time, id, limit) = Pagination {
            cursor: query.cursor,
            limit: query.limit,
        }
        .bounds(i64::MAX)?;
        let ids = readable_under_guard(&service, &account, query.scope.is_some())?;
        let db = service.metadata.connection()?;
        let mut stmt = db.prepare(
            "SELECT id, workspace_id, document_id, created_at, updated_at FROM ai_conversations
            WHERE owner=?1 AND workspace_id IS ?2 AND document_id IS ?3 AND (created_at,id)<(?4,?5)
            ORDER BY created_at DESC,id DESC LIMIT ?6",
        )?;
        let mut items = stmt
            .query_map(
                params![
                    account.username(),
                    query.workspace_id,
                    query.document_id,
                    time,
                    id,
                    limit as i64 + 1
                ],
                ConversationView::row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for c in &mut items {
            load_title(&db, c, &ids)?;
        }
        Ok(page(items, limit, |c| format!("{}.{}", c.created_at, c.id)))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnView {
    id: String,
    conversation_id: String,
    client_turn_id: String,
    operation_id: String,
    prompt: String,
    retry_of_turn_id: Option<String>,
    created_at: i64,
    history_truncated: bool,
    operation: OperationView,
}

const TURN_SELECT: &str =
    "SELECT t.id, t.conversation_id, t.client_turn_id, t.operation_id, t.prompt,
    t.retry_of_turn_id, t.created_at, t.history_truncated, json_extract(o.entry,'$.view')
    FROM ai_turns t JOIN ai_operations o ON o.id=t.operation_id";

impl TurnView {
    fn row(r: &Row) -> rusqlite::Result<Self> {
        let view: String = r.get(8)?;
        let operation = serde_json::from_str(&view).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(Self {
            id: r.get(0)?,
            conversation_id: r.get(1)?,
            client_turn_id: r.get(2)?,
            operation_id: r.get(3)?,
            prompt: r.get(4)?,
            retry_of_turn_id: r.get(5)?,
            created_at: r.get(6)?,
            history_truncated: r.get(7)?,
            operation,
        })
    }

    fn get(db: &Connection, conversation: &str, id: &str) -> Result<Self, ApiError> {
        db.query_row(
            &format!("{TURN_SELECT} WHERE t.conversation_id=?1 AND t.id=?2"),
            params![conversation, id],
            Self::row,
        )
        .optional()?
        .ok_or_else(ApiError::not_found)
    }
}

async fn list_turns(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<Pagination>,
) -> Result<Json<Page<TurnView>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let (time, last, limit) = query.bounds(i64::MIN)?;
        let _guard = service.metadata.ai_guard()?;
        super::ai_managed::sweep(&service)?;
        let _workspace_guard = service.metadata.workspace_guard()?;
        let c = authorize(&service, &account, &id)?;
        let ids = readable_under_guard(&service, &account, c.scope.is_some())?;
        let db = service.metadata.connection()?;
        let mut stmt = db.prepare(&format!(
            "{TURN_SELECT} WHERE t.conversation_id=?1 AND (t.created_at,t.id)>(?2,?3) AND {}
            ORDER BY t.created_at,t.id LIMIT ?4",
            visible("?5")
        ))?;
        let items = stmt
            .query_map(
                params![id, time, last, limit as i64 + 1, ids],
                TurnView::row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(page(items, limit, |t| format!("{}.{}", t.created_at, t.id)))
    })
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTurn {
    client_turn_id: String,
    mode: Mode,
    prompt: String,
    #[serde(default)]
    context: Vec<ContextRequest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    material_ids: Vec<String>,
    retry_of_turn_id: Option<String>,
}

async fn send(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    input: Result<Json<CreateTurn>, JsonRejection>,
) -> Result<(StatusCode, Json<TurnView>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    let browser_management = !headers.contains_key(axum::http::header::AUTHORIZATION);
    run(move || create_turn(&service, &account, id, input, browser_management)).await
}

fn create_turn(
    service: &DocumentService,
    account: &Account,
    id: String,
    input: CreateTurn,
    browser_management: bool,
) -> Result<(StatusCode, Json<TurnView>), ApiError> {
    let db = &service.metadata;
    let _guard = db.ai_guard()?;
    super::ai_managed::sweep(service)?;
    let workspace_guard = service.metadata.workspace_guard()?;
    let conversation = authorize(service, account, &id)?;
    if input.client_turn_id.trim().is_empty() || input.client_turn_id.len() > 128 {
        return Err(ApiError::invalid(
            "Expected a stable client turn ID of at most 128 bytes",
        ));
    }
    let ids = readable_under_guard(service, account, conversation.scope.is_some())?;
    let fingerprint = sha256_hex(&serde_json::to_vec(&input).map_err(ApiError::internal)?);
    {
        let conn = db.connection()?;
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id,fingerprint FROM ai_turns WHERE conversation_id=? AND client_turn_id=?",
                params![id, input.client_turn_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior_id, prior_fingerprint)) = existing {
            let prior = TurnView::get(&conn, &id, &prior_id)?;
            drop(conn);
            Operation::get(db, &prior.operation_id)?.ensure_owner(service, account, false)?;
            if fingerprint != prior_fingerprint {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "client_turn_changed",
                    "This client turn ID already has a different request",
                ));
            }
            return Ok((StatusCode::ACCEPTED, Json(prior)));
        }
        if let Some(prior) = &input.retry_of_turn_id {
            let prior = conn
                .query_row(
                    &format!(
                        "{TURN_SELECT} WHERE t.conversation_id=?1 AND t.id=?2 AND {}",
                        visible("?3")
                    ),
                    params![id, prior, ids],
                    TurnView::row,
                )
                .optional()?
                .ok_or_else(ApiError::not_found)?;
            if !matches!(
                prior.operation.status,
                OperationStatus::Failed | OperationStatus::Canceled | OperationStatus::Conflict
            ) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "turn_not_retryable",
                    "Only an unsuccessful turn can be retried",
                ));
            }
        }
        let active = conn.query_row(
            &format!("SELECT o.entry,{} FROM ai_turns t JOIN ai_operations o ON t.operation_id=o.id
                WHERE t.conversation_id=?1 AND o.status IN ('queued','running','needs_confirmation')",visible("?2")),
            params![id,ids],|row| Ok((row.get::<_,String>(0)?,row.get::<_,bool>(1)?)),
        ).optional()?;
        drop(conn);
        drop(workspace_guard);
        if let Some((entry, visible)) = active {
            if visible {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "conversation_busy",
                    "Finish or stop the active turn first",
                ));
            }
            // Retire the inaccessible lease/preview before accepting a new turn. A durable
            // write whose acknowledgement was interrupted still retains its committed receipt.
            let mut op: Operation = serde_json::from_str(&entry).map_err(ApiError::internal)?;
            if !op.recover_committed(service)? {
                op.lease = None;
                op.result_fingerprint = None;
                op.settle(db, OperationStatus::Canceled)?;
            }
        }
    }
    let task = TaskInput {
        scope: conversation.scope,
        workspace_id: conversation.workspace_id,
        document_id: conversation.document_id,
        mode: input.mode,
        prompt: input.prompt,
        context: input.context,
    };
    let mut op = Operation::prepare(service, account, task)?;
    op.browser_management = browser_management;
    let task = op.input.as_ref().expect("new queued operation");
    for context in &task.context {
        let document = service.get_in(
            account,
            task.workspace_id
                .as_deref()
                .ok_or_else(ApiError::not_found)?,
            &context.document_id,
        )?;
        if context
            .revision
            .as_ref()
            .is_some_and(|rev| rev != &document.revision)
        {
            return Err(ApiError::conflict(Some(document.revision)));
        }
        if context.from.is_some() {
            super::ai_runner::select(&document.markdown, context)?;
        }
    }
    let mut conn = db.connection()?;
    let tx = conn.transaction()?;
    let turn_id = Uuid::new_v4().to_string();
    // Monotone within the conversation even if multiple sends share a clock tick.
    let now = Utc::now()
        .timestamp_millis()
        .max(conversation.updated_at + 1);
    op.store_in(&tx, true)?;
    tx.execute(
        "INSERT INTO ai_turns(id, conversation_id, client_turn_id, operation_id, fingerprint,
                              prompt, retry_of_turn_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            turn_id,
            id,
            input.client_turn_id,
            op.view.id,
            fingerprint,
            task.prompt,
            input.retry_of_turn_id,
            now
        ],
    )?;
    super::ai_materials::bind_turn(&tx, &id, &op.view.id, &input.material_ids)?;
    tx.execute(
        "UPDATE ai_conversations SET updated_at=? WHERE id=?",
        params![now, id],
    )?;
    let turn = TurnView::get(&tx, &id, &turn_id)?;
    tx.commit()?;
    Ok((StatusCode::ACCEPTED, Json(turn)))
}

#[derive(Serialize)]
struct HistoryPair {
    prompt: String,
    answer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaimHistory {
    history: Vec<HistoryPair>,
    history_truncated: bool,
}

/// Called under the dispatch lock after the operation actor's current access is verified.
/// Assemble only user-visible pairs at claim time. Never persist a duplicate history in task input.
pub(super) fn claim_history(
    service: &DocumentService,
    account: &Account,
    op: &mut Operation,
    prompt_bytes: usize,
) -> Result<Option<ClaimHistory>, ApiError> {
    const MAX_PAIRS: usize = 12;
    const INPUT_BYTES: usize = 256 * 1024;
    let ids = readable_under_guard(service, account, op.is_global())?;
    let operation = &op.view.id;
    let conn = service.metadata.connection()?;
    let turn: Option<(String, i64)> = conn
        .query_row(
            "SELECT conversation_id,created_at FROM ai_turns WHERE operation_id=?",
            [operation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((conversation, created)) = turn else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT t.prompt,json_extract(o.entry,'$.view.answer'),o.id,json_extract(o.entry,'$.workspaceDependencies') FROM ai_turns t
         JOIN ai_operations o ON o.id=t.operation_id
         WHERE t.conversation_id=? AND t.created_at<? AND o.status='succeeded' AND {}
           AND NOT EXISTS (SELECT 1 FROM ai_material_reads r
             LEFT JOIN ai_materials m ON m.id=r.material_id WHERE r.operation_id=o.id
             AND (m.id IS NULL OR m.expires_at<=unixepoch() OR m.status!='ready'))
         ORDER BY t.created_at DESC LIMIT 13", visible("?3")))?;
    let mut history = Vec::new();
    let mut remaining = INPUT_BYTES.saturating_sub(prompt_bytes);
    let mut truncated = false;
    let mut rows = stmt.query(params![conversation, created, ids])?;
    while let Some(row) = rows.next()? {
        let pair = HistoryPair {
            prompt: row.get(0)?,
            answer: row.get(1)?,
        };
        let bytes = serde_json::to_vec(&pair).map_err(ApiError::internal)?.len() + 1;
        if history.len() == MAX_PAIRS || bytes > remaining {
            truncated = true;
            break;
        }
        // A follow-up answer may quote the earlier answer even without another tool read.
        conn.execute(
            "INSERT OR IGNORE INTO ai_material_reads(operation_id,material_id)
             SELECT ?1,material_id FROM ai_material_reads WHERE operation_id=?2",
            params![operation, row.get::<_, String>(2)?],
        )?;
        if let Some(dependencies) = row.get::<_, Option<String>>(3)? {
            op.workspace_dependencies.extend(
                serde_json::from_str::<Vec<String>>(&dependencies).map_err(ApiError::internal)?,
            );
        }
        history.push(pair);
        remaining -= bytes;
    }
    history.reverse();
    conn.execute(
        "UPDATE ai_turns SET history_truncated=? WHERE operation_id=?",
        params![truncated, operation],
    )?;
    Ok(Some(ClaimHistory {
        history,
        history_truncated: truncated,
    }))
}

fn finish_commit(service: &DocumentService, op: &mut Operation) -> Result<(), ApiError> {
    if op.view.status == OperationStatus::Running && op.accepted.is_some() {
        super::ai_managed::reconcile(service, op)?;
        if op.view.status != OperationStatus::Running {
            return Ok(());
        }
        let actor = op.actor(service, op.view.mode == Mode::Edit)?;
        if let Err(e) = op.apply_result(service, &actor) {
            if e.status() != StatusCode::CONFLICT {
                return Err(e);
            }
        }
    }
    Ok(())
}

async fn cancel(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path((id, turn)): Path<(String, String)>,
) -> Result<Json<TurnView>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        authorize(&service, &account, &id)?;
        let mut turn = TurnView::get(&*db.connection()?, &id, &turn)?;
        let mut op = Operation::get(db, &turn.operation_id)?;
        op.ensure_owner(&service, &account, false)?;
        finish_commit(&service, &mut op)?;
        if matches!(
            op.view.status,
            OperationStatus::Queued | OperationStatus::Running | OperationStatus::NeedsConfirmation
        ) {
            op.lease = None;
            op.result_fingerprint = None;
            op.settle(db, OperationStatus::Canceled)?;
        }
        op.ensure_owner(&service, &account, false)?;
        turn.operation = op.view;
        Ok(Json(turn))
    })
    .await
}

async fn delete(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || delete_conversation(&service, &account, id)).await
}

fn delete_conversation(
    service: &DocumentService,
    account: &Account,
    id: String,
) -> Result<StatusCode, ApiError> {
    let db = &service.metadata;
    let _guard = db.ai_guard()?;
    authorize(service, account, &id)?;
    let committing = {
        let conn = db.connection()?;
        let mut q = conn.prepare(
            "SELECT o.id FROM ai_turns t JOIN ai_operations o ON o.id=t.operation_id
             WHERE t.conversation_id=? AND o.status='running' AND json_type(o.entry,'$.accepted')='object'",
        )?;
        let ids = q
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids
    };
    for op_id in committing {
        finish_commit(service, &mut Operation::get(db, &op_id)?)?;
    }
    let mut conn = db.connection()?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM ai_events WHERE operation_id IN (SELECT operation_id FROM ai_turns WHERE conversation_id=?)",
        [&id],
    )?;
    // Construct the receipt from its permitted fields. This also removes
    // extension data retained by older versions of the persisted JSON.
    tx.execute(
        "UPDATE ai_operations SET lease_id=NULL, expires_at=NULL, entry=json_object(
             'owner', json_extract(entry,'$.owner'),
             'credential_version', json_extract(entry,'$.credential_version'),
             'undo_id', json_extract(entry,'$.undo_id'),
             'workspaceDependencies', COALESCE(json_extract(entry,'$.workspaceDependencies'), json('[]')),
             'delivered', json('[]'),
             'view', json_object('id', id, 'workspaceId', COALESCE(workspace_id,''),
                 'scope', json_extract(entry,'$.view.scope'), 'targetWorkspaceId', json_extract(entry,'$.view.targetWorkspaceId'),
                 'documentId', json_extract(entry,'$.view.documentId'),
                 'mode', json_extract(entry,'$.view.mode'), 'status', status,
                 'commitId', json_extract(entry,'$.view.commitId'),
                 'transferResult', json_extract(entry,'$.view.transferResult'),
                 'workspaceManagement', json_extract(entry,'$.view.workspaceManagement'),
                 'writeResult', json_extract(entry,'$.view.writeResult'),
                 'undoCommitId', json_extract(entry,'$.view.undoCommitId'),
                 'changes', json_extract(entry,'$.view.changes'), 'sources', json('[]')))
         WHERE id IN (SELECT operation_id FROM ai_turns WHERE conversation_id=?)
           AND COALESCE(json_extract(entry,'$.view.commitId'),json_extract(entry,'$.view.transferResult'),json_extract(entry,'$.view.workspaceManagement')) IS NOT NULL",
        [&id],
    )?;
    // Delete non-committed operations and turn bindings together under deferred FK checks.
    tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
    tx.execute(
        "DELETE FROM ai_operations WHERE id IN (SELECT operation_id FROM ai_turns WHERE conversation_id=?)
         AND COALESCE(json_extract(entry,'$.view.commitId'),json_extract(entry,'$.view.transferResult'),json_extract(entry,'$.view.workspaceManagement')) IS NULL",
        [&id],
    )?;
    let materials = super::ai_materials::remove_conversation(&tx, &id)?;
    tx.execute("DELETE FROM ai_conversations WHERE id=?", [&id])?;
    tx.commit()?;
    drop(conn);
    for material in materials {
        super::ai_materials::unlink(db, &material)?;
    }
    Ok(StatusCode::NO_CONTENT)
}
