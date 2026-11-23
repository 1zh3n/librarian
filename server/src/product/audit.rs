use rusqlite::{params, Connection, Transaction};
use serde_json::Value;

use super::contract::ApiError;

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS product_audit (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           at INTEGER NOT NULL,
           actor TEXT,
           workspace_id TEXT,
           action TEXT NOT NULL,
           target TEXT,
           result TEXT NOT NULL,
           rule_id TEXT,
           request_id TEXT,
           metadata TEXT
         );
         CREATE INDEX IF NOT EXISTS product_audit_workspace ON product_audit(workspace_id, at);
         CREATE INDEX IF NOT EXISTS product_audit_action ON product_audit(action, at);",
    )
}

pub(crate) struct Event<'a> {
    pub actor: Option<&'a str>,
    pub workspace: Option<&'a str>,
    pub action: &'a str,
    pub target: Option<&'a str>,
    pub result: &'a str,
    pub rule_id: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub metadata: Option<&'a Value>,
}

/// Append one audit event. Callers must not put document content, tokens, keys,
/// prompts, or share credentials into `metadata`.
pub(crate) fn record_in(connection: &Connection, event: Event<'_>) -> Result<(), ApiError> {
    let metadata = event.metadata.map(Value::to_string);
    connection.execute(
        "INSERT INTO product_audit
           (at, actor, workspace_id, action, target, result, rule_id, request_id, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            chrono::Utc::now().timestamp(),
            event.actor,
            event.workspace,
            event.action,
            event.target,
            event.result,
            event.rule_id,
            event.request_id,
            metadata,
        ],
    )?;
    Ok(())
}
