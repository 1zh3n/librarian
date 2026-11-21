use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    accounts::administrator,
    ai_configuration::{check_selection, ModelSelection, Thinking},
    contract::ApiError,
    documents::{body, run, DocumentService},
};

const DEADLINE_SECONDS: i64 = 120;

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_probes (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, credential_version TEXT NOT NULL,
        selection TEXT NOT NULL, connection_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, error_code TEXT, lease TEXT UNIQUE, instance TEXT, expires_at INTEGER,
        provider_issued INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS ai_probe_queue ON ai_probes(status,created_at);",
    )
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/settings/connections/{id}/probe", post(start))
        .route("/ai/settings/probes/{id}", get(status))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Choice {
    model_id: String,
    thinking: Thinking,
}

async fn start(
    State(service): State<Arc<DocumentService>>,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<Choice>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let admin = administrator(&service, &headers, true)?;
    let choice = body(request)?;
    let selection = ModelSelection {
        connection_id,
        model_id: choice.model_id,
        thinking: choice.thinking,
    };
    run(move || {
        let _guard=service.metadata.ai_guard()?;
        let db=service.metadata.connection()?;
        if !enabled(&db)? {
            return Err(ApiError::new(StatusCode::CONFLICT,"ai_disabled","Resume AI before testing a connection"));
        }
        let owner=admin.username();
        let credential=service.spaces.users.credential_version(owner).ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "administrator_required", "Administrator access required"))?;
        let version=check_selection(&service,&db,&selection,false)?;
        let id=Uuid::new_v4().to_string();
        db.execute("INSERT INTO ai_probes(id,owner,credential_version,selection,connection_version,created_at,status)
            VALUES(?1,?2,?3,?4,?5,unixepoch(),'queued')",
            params![id,owner,credential,json!(selection).to_string(),version])?;
        Ok((StatusCode::ACCEPTED,Json(json!({"id":id,"status":"queued"}))))
    }).await
}

fn enabled(db: &Connection) -> Result<bool, ApiError> {
    Ok(db.query_row(
        "SELECT enabled FROM ai_configuration WHERE singleton=1",
        [],
        |r| r.get(0),
    )?)
}

struct Probe {
    id: String,
    owner: String,
    credential_version: String,
    selection: ModelSelection,
    connection_version: i64,
    status: String,
    error_code: Option<String>,
    instance: Option<String>,
    expires_at: Option<i64>,
    provider_issued: bool,
}

const FIELDS:&str="id,owner,credential_version,selection,connection_version,status,error_code,instance,expires_at,provider_issued";

impl Probe {
    fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let selection: String = row.get(3)?;
        let selection = serde_json::from_str(&selection).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(Self {
            id: row.get(0)?,
            owner: row.get(1)?,
            credential_version: row.get(2)?,
            selection,
            connection_version: row.get(4)?,
            status: row.get(5)?,
            error_code: row.get(6)?,
            instance: row.get(7)?,
            expires_at: row.get(8)?,
            provider_issued: row.get(9)?,
        })
    }
    fn valid(&self, service: &DocumentService, db: &Connection) -> Result<bool, ApiError> {
        if !enabled(db)?
            || !service.spaces.users.is_admin(&self.owner)
            || service
                .spaces
                .users
                .credential_version(&self.owner)
                .as_ref()
                != Some(&self.credential_version)
        {
            return Ok(false);
        }
        match check_selection(service, db, &self.selection, false) {
            Ok(version) => Ok(version == self.connection_version),
            Err(e) if e.status().is_client_error() => Ok(false),
            Err(e) => Err(e),
        }
    }
    fn finish(&mut self, db: &Connection, code: Option<&str>) -> Result<(), ApiError> {
        self.status = if code.is_some() {
            "failed"
        } else {
            "succeeded"
        }
        .into();
        self.error_code = code.map(str::to_owned);
        db.execute(
            "UPDATE ai_probes SET status=?1,error_code=?2 WHERE id=?3",
            params![self.status, self.error_code, self.id],
        )?;
        Ok(())
    }
    fn view(&self) -> Value {
        json!({"id":self.id,"status":self.status,"errorCode":self.error_code})
    }
}
fn expire(db: &Connection, now: i64) -> Result<(), ApiError> {
    db.execute("UPDATE ai_probes SET status='failed',error_code='queue_timeout' WHERE status='queued' AND created_at<=?1",[now-DEADLINE_SECONDS])?;
    db.execute("UPDATE ai_probes SET status='failed',error_code='timeout' WHERE status='running' AND expires_at<=?1",[now])?;
    Ok(())
}

async fn status(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = administrator(&service, &headers, false)?;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let db = service.metadata.connection()?;
        expire(&db, chrono::Utc::now().timestamp())?;
        let mut probe = db
            .query_row(
                &format!("SELECT {FIELDS} FROM ai_probes WHERE id=?1 AND owner=?2"),
                params![id, user.username()],
                Probe::row,
            )
            .optional()?
            .ok_or_else(ApiError::not_found)?;
        if matches!(probe.status.as_str(), "queued" | "running") && !probe.valid(&service, &db)? {
            probe.finish(&db, Some("unavailable"))?;
        }
        Ok(Json(probe.view()))
    })
    .await
}

// Call after authenticating the instance and obtaining the shared AI write guard.
pub(super) fn claim(
    service: &DocumentService,
    db: &Connection,
    instance: &str,
    now: i64,
) -> Result<Option<Value>, ApiError> {
    expire(db, now)?;
    let mut statement = db.prepare(&format!(
        "SELECT {FIELDS} FROM ai_probes WHERE status='queued' ORDER BY created_at,rowid LIMIT 32"
    ))?;
    let probes = statement
        .query_map([], Probe::row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for mut probe in probes {
        if !probe.valid(service, db)? {
            probe.finish(db, Some("unavailable"))?;
            continue;
        }
        let lease = Uuid::new_v4().to_string();
        let expires = now + DEADLINE_SECONDS;
        db.execute(
            "UPDATE ai_probes SET status='running',lease=?1,instance=?2,expires_at=?3 WHERE id=?4",
            params![lease, instance, expires, probe.id],
        )?;
        return Ok(Some(
            json!({"taskKind":"probe","leaseId":lease,"operationId":probe.id,
            "expiresAt":expires,"selection":{"modelId":probe.selection.model_id,"thinking":probe.selection.thinking}}),
        ));
    }
    Ok(None)
}

pub(super) enum ProbeAction<'a> {
    Provider,
    CheckProvider,
    Renew,
    Finish,
    Fail(&'a str),
    Deny,
}

fn inactive() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "lease_inactive",
        "This lease is no longer active",
    )
}

// A provider lookup returns the checked connection ID and version to the v2 provider handler.
// The handler resolves the pinned destination, then rechecks the version before disclosing the key.
pub(super) fn lease(
    service: &DocumentService,
    db: &Connection,
    id: &str,
    instance: &str,
    action: ProbeAction<'_>,
) -> Result<Option<Value>, ApiError> {
    let now = chrono::Utc::now().timestamp();
    expire(db, now)?;
    let Some(mut probe) = db
        .query_row(
            &format!("SELECT {FIELDS} FROM ai_probes WHERE lease=?1"),
            [id],
            Probe::row,
        )
        .optional()?
    else {
        return Ok(None);
    };
    if probe.instance.as_deref() != Some(instance) {
        return Err(ApiError::not_found());
    }
    if probe.expires_at.is_none_or(|expiry| expiry <= now) || !probe.valid(service, db)? {
        if probe.status == "running" {
            probe.finish(db, Some("unavailable"))?;
        }
        return Err(inactive());
    }
    if probe.status != "running" {
        let replay = match action {
            ProbeAction::Finish => probe.status == "succeeded",
            ProbeAction::Fail(code) => {
                probe.status == "failed" && probe.error_code.as_deref() == Some(code)
            }
            _ => false,
        };
        return if replay {
            Ok(Some(probe.view()))
        } else {
            Err(inactive())
        };
    }
    let response = match action {
        ProbeAction::Provider => {
            if probe.provider_issued {
                return Err(inactive());
            }
            db.execute(
                "UPDATE ai_probes SET provider_issued=1 WHERE id=?1",
                [&probe.id],
            )?;
            json!({"connectionId":probe.selection.connection_id,"version":probe.connection_version})
        }
        ProbeAction::CheckProvider => {
            if !probe.provider_issued {
                return Err(inactive());
            }
            json!({"connectionId":probe.selection.connection_id,"version":probe.connection_version})
        }
        ProbeAction::Renew => {
            let expires = now + DEADLINE_SECONDS;
            db.execute(
                "UPDATE ai_probes SET expires_at=?1 WHERE id=?2",
                params![expires, probe.id],
            )?;
            json!({"expiresAt":expires})
        }
        ProbeAction::Finish => {
            probe.finish(db, None)?;
            probe.view()
        }
        ProbeAction::Fail(code) => {
            if !matches!(
                code,
                "authentication" | "rate_limit" | "timeout" | "incompatible" | "unavailable"
            ) {
                return Err(ApiError::invalid("Unknown probe diagnostic"));
            }
            probe.finish(db, Some(code))?;
            probe.view()
        }
        ProbeAction::Deny => return Err(ApiError::not_found()),
    };
    Ok(Some(response))
}
