use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{accounts, audit, contract::ApiError, documents::run, documents::DocumentService};

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;
const EXPORT_LIMIT: u32 = 10_000;

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/audit", get(list))
        .route("/audit.csv", get(export))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Filters {
    workspace_id: Option<String>,
    actor: Option<String>,
    action: Option<String>,
    result: Option<String>,
    before: Option<i64>,
    limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEventView {
    id: i64,
    at: i64,
    actor: Option<String>,
    workspace_id: Option<String>,
    action: String,
    target: Option<String>,
    result: String,
    rule_id: Option<String>,
    request_id: Option<String>,
    metadata: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditList {
    events: Vec<AuditEventView>,
    next_before: Option<i64>,
}

struct AuditRow {
    id: i64,
    at: i64,
    actor: Option<String>,
    workspace_id: Option<String>,
    action: String,
    target: Option<String>,
    result: String,
    rule_id: Option<String>,
    request_id: Option<String>,
    metadata: Option<String>,
}

fn normalize(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn validate(filters: &Filters) -> Result<(), ApiError> {
    if let Some(result) = filters.result.as_deref() {
        if result != "ok" && result != "denied" {
            return Err(ApiError::invalid("Unknown audit result"));
        }
    }
    Ok(())
}

fn fetch(
    service: &DocumentService,
    filters: &Filters,
    limit: u32,
) -> Result<Vec<AuditRow>, ApiError> {
    audit::prune(&service.metadata)?;
    let connection = service.metadata.connection()?;
    let mut statement = connection.prepare(
        "SELECT id, at, actor, workspace_id, action, target, result, rule_id, request_id, metadata
         FROM product_audit
         WHERE (?1 IS NULL OR workspace_id = ?1)
           AND (?2 IS NULL OR actor = ?2)
           AND (?3 IS NULL OR action = ?3)
           AND (?4 IS NULL OR result = ?4)
           AND (?5 IS NULL OR id < ?5)
         ORDER BY id DESC LIMIT ?6",
    )?;
    let rows = statement.query_map(
        params![
            filters.workspace_id,
            filters.actor,
            filters.action,
            filters.result,
            filters.before,
            limit,
        ],
        |row| {
            Ok(AuditRow {
                id: row.get(0)?,
                at: row.get(1)?,
                actor: row.get(2)?,
                workspace_id: row.get(3)?,
                action: row.get(4)?,
                target: row.get(5)?,
                result: row.get(6)?,
                rule_id: row.get(7)?,
                request_id: row.get(8)?,
                metadata: row.get(9)?,
            })
        },
    )?;
    rows.collect::<Result<Vec<_>, _>>().map_err(ApiError::from)
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    Query(mut filters): Query<Filters>,
    headers: HeaderMap,
) -> Result<Json<AuditList>, ApiError> {
    accounts::administrator(&service, &headers, false)?;
    filters.workspace_id = normalize(filters.workspace_id);
    filters.actor = normalize(filters.actor);
    filters.action = normalize(filters.action);
    filters.result = normalize(filters.result);
    validate(&filters)?;
    run(move || {
        let limit = filters.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let mut rows = fetch(&service, &filters, limit + 1)?;
        let next_before = if rows.len() > limit as usize {
            rows.truncate(limit as usize);
            rows.last().map(|row| row.id)
        } else {
            None
        };
        Ok(Json(AuditList {
            events: rows.into_iter().map(view).collect(),
            next_before,
        }))
    })
    .await
}

async fn export(
    State(service): State<Arc<DocumentService>>,
    Query(mut filters): Query<Filters>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    accounts::administrator(&service, &headers, false)?;
    filters.workspace_id = normalize(filters.workspace_id);
    filters.actor = normalize(filters.actor);
    filters.action = normalize(filters.action);
    filters.result = normalize(filters.result);
    validate(&filters)?;
    run(move || {
        let rows = fetch(&service, &filters, EXPORT_LIMIT)?;
        let body = csv(rows);
        let filename = format!(
            "librarian-audit-{}.csv",
            chrono::Utc::now().format("%Y%m%d")
        );
        let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .map_err(ApiError::internal)?;
        Ok((
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/csv; charset=utf-8"),
                ),
                (header::CONTENT_DISPOSITION, disposition),
            ],
            body,
        )
            .into_response())
    })
    .await
}

fn view(row: AuditRow) -> AuditEventView {
    AuditEventView {
        id: row.id,
        at: row.at,
        actor: row.actor,
        workspace_id: row.workspace_id,
        action: row.action,
        target: row.target,
        result: row.result,
        rule_id: row.rule_id,
        request_id: row.request_id,
        metadata: row
            .metadata
            .and_then(|value| serde_json::from_str(&value).ok()),
    }
}

fn csv(rows: Vec<AuditRow>) -> String {
    let mut output =
        String::from("at,actor,workspace_id,action,target,result,rule_id,request_id,metadata\n");
    for row in rows {
        let at = chrono::DateTime::from_timestamp(row.at, 0)
            .map(|value| value.to_rfc3339())
            .unwrap_or_else(|| row.at.to_string());
        let cells = [
            at,
            row.actor.unwrap_or_default(),
            row.workspace_id.unwrap_or_default(),
            row.action,
            row.target.unwrap_or_default(),
            row.result,
            row.rule_id.unwrap_or_default(),
            row.request_id.unwrap_or_default(),
            row.metadata.unwrap_or_default(),
        ];
        output.push_str(
            &cells
                .iter()
                .map(|cell| csv_cell(cell))
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push('\n');
    }
    output
}

fn csv_cell(value: &str) -> String {
    let value = if value
        .chars()
        .next()
        .is_some_and(|character| matches!(character, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::csv_cell;

    #[test]
    fn csv_cells_escape_formulas_and_quotes() {
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert_eq!(csv_cell("+cmd"), "'+cmd");
        assert_eq!(csv_cell("-2"), "'-2");
        assert_eq!(csv_cell("@user"), "'@user");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_cell("line\nbreak"), "\"line\nbreak\"");
    }
}
