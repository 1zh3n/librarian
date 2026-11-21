//! Account preferences, connection versions and installation-bound credentials.
use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    accounts::{administrator, browser},
    ai_credentials, ai_provider,
    ai_settings::DiscoveredCatalog,
    contract::ApiError,
    documents::{body, run, DocumentService},
};

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS ai_connections (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, base_url TEXT NOT NULL, ciphertext TEXT,
        version INTEGER NOT NULL, enabled INTEGER NOT NULL, catalog TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_configuration (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
        enabled INTEGER NOT NULL, mode TEXT NOT NULL, default_choice TEXT);
        INSERT OR IGNORE INTO ai_configuration VALUES(1,1,1,'legacy',NULL);
        CREATE TABLE IF NOT EXISTS ai_account_choices (account TEXT PRIMARY KEY, selection TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_managed_activation (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor TEXT NOT NULL,
        activation_id TEXT NOT NULL, expected_version INTEGER NOT NULL,
        selection TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_runner_instances (
        id TEXT PRIMARY KEY, token_digest TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0);")
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/settings", get(view))
        .route("/ai/settings/connections", post(create))
        .route(
            "/ai/settings/connections/{id}",
            patch(update).delete(remove),
        )
        .route("/ai/settings/preference", put(preference))
        .route("/ai/settings/default", put(default_choice))
        .route("/ai/settings/managed-activation", post(activate))
        .route("/ai/settings/global-enabled", put(global_enabled))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Thinking {
    ProviderDefault,
    Off,
    Effort { level: String },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ModelSelection {
    pub connection_id: String,
    pub model_id: String,
    pub thinking: Thinking,
}

#[derive(Clone)]
pub(super) struct SavedCredential {
    pub version: i64,
    pub base_url: String,
    pub api_key: String,
}

struct SavedConnection {
    id: String,
    label: String,
    base_url: String,
    ciphertext: Option<String>,
    version: i64,
    enabled: bool,
    catalog: DiscoveredCatalog,
}

impl SavedConnection {
    fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let raw: String = row.get(6)?;
        let catalog = serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(Self {
            id: row.get(0)?,
            label: row.get(1)?,
            base_url: row.get(2)?,
            ciphertext: row.get(3)?,
            version: row.get(4)?,
            enabled: row.get(5)?,
            catalog,
        })
    }

    fn secret(&self, service: &DocumentService) -> Result<String, ApiError> {
        let sealed = self.ciphertext.as_deref().ok_or_else(|| {
            conflict(
                "ai_credential_unavailable",
                "Re-enter the connection credential",
            )
        })?;
        ai_credentials::unseal(
            &service.metadata.product_file("ai-install.key"),
            &self.id,
            sealed,
        )
    }
}

const COLUMNS: &str = "id,label,base_url,ciphertext,version,enabled,catalog";

fn connection(db: &Connection, id: &str) -> Result<SavedConnection, ApiError> {
    db.query_row(
        &format!("SELECT {COLUMNS} FROM ai_connections WHERE id=?1"),
        [id],
        SavedConnection::row,
    )
    .optional()?
    .ok_or_else(ApiError::not_found)
}

fn conflict(code: &'static str, msg: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, msg)
}
fn stale() -> ApiError {
    conflict(
        "ai_settings_changed",
        "Settings changed. Refresh and try again",
    )
}

pub(super) fn saved_credential(
    service: &DocumentService,
    id: &str,
) -> Result<SavedCredential, ApiError> {
    let db = service.metadata.connection()?;
    let conn = connection(&db, id)?;
    Ok(SavedCredential {
        api_key: conn.secret(service)?,
        version: conn.version,
        base_url: conn.base_url,
    })
}

pub(super) fn refresh_catalog(
    service: &DocumentService,
    id: &str,
    version: i64,
    catalog: &DiscoveredCatalog,
) -> Result<(), ApiError> {
    let _guard = service.metadata.ai_guard()?;
    let mut db = service.metadata.connection()?;
    let tx = db.transaction()?;
    let old = connection(&tx, id)?;
    if old.version != version {
        return Err(stale());
    }
    let changed = json!(old.catalog.models) != json!(catalog.models);
    tx.execute(
        "UPDATE ai_connections SET catalog=?1,version=version+?2 WHERE id=?3",
        params![json!(catalog).to_string(), i64::from(changed), id],
    )?;
    if changed {
        bump(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

fn bump(tx: &Transaction<'_>) -> Result<(), ApiError> {
    tx.execute(
        "UPDATE ai_configuration SET version=version+1 WHERE singleton=1",
        [],
    )?;
    Ok(())
}

fn decode_selection(value: Option<String>) -> Result<Option<ModelSelection>, ApiError> {
    value
        .map(|s| serde_json::from_str(&s).map_err(ApiError::internal))
        .transpose()
}

fn choices(
    db: &Connection,
    account: &str,
) -> Result<(Option<ModelSelection>, Option<ModelSelection>), ApiError> {
    let preferred = db
        .query_row(
            "SELECT selection FROM ai_account_choices WHERE account=?1",
            [account],
            |r| r.get(0),
        )
        .optional()?;
    let default = db.query_row(
        "SELECT default_choice FROM ai_configuration WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    Ok((decode_selection(preferred)?, decode_selection(default)?))
}

fn validate_choice(conn: &SavedConnection, selected: &ModelSelection) -> Result<(), ApiError> {
    let model = conn
        .catalog
        .models
        .iter()
        .find(|m| m.id == selected.model_id)
        .ok_or_else(|| ApiError::invalid("Choose an available model"))?;
    let valid = match &selected.thinking {
        Thinking::ProviderDefault => true,
        Thinking::Off => model
            .effort
            .as_ref()
            .is_some_and(|e| !e.supported_levels.is_empty()),
        Thinking::Effort { level } => model
            .effort
            .as_ref()
            .is_some_and(|e| e.supported_levels.contains(level)),
    };
    if valid {
        Ok(())
    } else {
        Err(ApiError::invalid("Choose a supported thinking setting"))
    }
}

pub(super) fn check_selection(
    service: &DocumentService,
    db: &Connection,
    s: &ModelSelection,
    require_enabled: bool,
) -> Result<i64, ApiError> {
    let conn = connection(db, &s.connection_id)?;
    if require_enabled && !conn.enabled {
        return Err(ApiError::invalid("Choose an enabled connection"));
    }
    conn.secret(service)?;
    validate_choice(&conn, s)?;
    Ok(conn.version)
}

pub(super) fn resolve_selection(
    service: &DocumentService,
    db: &Connection,
    account: &str,
) -> Result<(Option<ModelSelection>, Option<&'static str>), ApiError> {
    let (preferred, default) = choices(db, account)?;
    let mut reason = None;
    for mut choice in [preferred, default].into_iter().flatten() {
        let conn = match connection(db, &choice.connection_id) {
            Ok(c) => c,
            Err(e) if e.status() == StatusCode::NOT_FOUND => {
                reason = Some("connection_unavailable");
                continue;
            }
            Err(e) => return Err(e),
        };
        if !conn.enabled || conn.secret(service).is_err() {
            reason = Some("connection_unavailable");
            continue;
        }
        if !conn.catalog.models.iter().any(|m| m.id == choice.model_id) {
            reason = Some("model_unavailable");
            continue;
        }
        if validate_choice(&conn, &choice).is_err() {
            choice.thinking = Thinking::ProviderDefault;
            reason = Some("effort_unavailable");
        }
        return Ok((Some(choice), reason));
    }
    Ok((None, reason))
}

async fn view(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = browser(&service, &headers, false)?;
    run(move || view_sync(&service, user.username())).await
}

fn view_sync(service: &DocumentService, actor: &str) -> Result<Json<Value>, ApiError> {
    let admin = service.spaces.users.is_admin(actor);
    let db = service.metadata.connection()?;
    let (version, enabled, mode): (i64, bool, String) = db.query_row(
        "SELECT version,enabled,mode FROM ai_configuration WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let mut stmt = db.prepare(&format!(
        "SELECT {COLUMNS} FROM ai_connections WHERE ?1 OR enabled=1 ORDER BY label,id"
    ))?;
    let mut items = Vec::new();
    for item in stmt.query_map([admin], SavedConnection::row)? {
        let c = item?;
        let mut out = json!({"id":c.id,"label":c.label,"provider":"deepseek","version":c.version,"enabled":c.enabled,"models":c.catalog.models,"fetchedAt":c.catalog.fetched_at});
        if admin {
            out["baseUrl"] = json!(c.base_url);
            out["hasApiKey"] = json!(c.ciphertext.is_some());
            out["credentialAvailable"] = json!(c.secret(service).is_ok());
        }
        items.push(out);
    }
    let (preference, default) = choices(&db, actor)?;
    let (effective, fallback) = resolve_selection(service, &db, actor)?;
    let online = runner_online(&db)?;
    Ok(Json(
        json!({"settingsVersion":version,"globalEnabled":enabled,"dispatchMode":mode,"connections":items,"defaultSelection":default,"preference":preference,"effectiveSelection":effective,"fallbackReason":fallback,"runnerOnline":online}),
    ))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum KeyChange {
    Keep,
    Clear,
    Replace {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    label: String,
    provider: String,
    base_url: String,
    discovery_id: String,
    key_change: KeyChange,
}

fn label(value: &str) -> Result<&str, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 {
        return Err(ApiError::invalid(
            "Enter a connection name up to 128 characters",
        ));
    }
    Ok(value)
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    request: Result<Json<Create>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let admin = administrator(&service, &headers, true)?;
    let input = body(request)?;
    run(move || create_sync(&service, admin.username(), input)).await
}

fn create_sync(
    service: &DocumentService,
    actor: &str,
    input: Create,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let KeyChange::Replace { api_key } = input.key_change else {
        return Err(ApiError::invalid("Enter a new connection credential"));
    };
    let name = label(&input.label)?;
    let endpoint = ai_provider::normalize(&input.base_url)?.to_string();
    let catalog = service.ai_discovery.validate_discovery(
        actor,
        &input.provider,
        &endpoint,
        &api_key,
        &input.discovery_id,
    )?;
    let id = Uuid::new_v4().to_string();
    let sealed = ai_credentials::seal(
        &service.metadata.product_file("ai-install.key"),
        &id,
        &api_key,
    )?;
    let mut db = service.metadata.connection()?;
    let tx = db.transaction()?;
    tx.execute("INSERT INTO ai_connections (id,label,base_url,ciphertext,version,enabled,catalog) VALUES(?1,?2,?3,?4,1,0,?5)",
            params![id,name,endpoint,sealed,json!(catalog).to_string()])?;
    bump(&tx)?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({"id":id,"version":1}))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Patch {
    expected_version: i64,
    label: Option<String>,
    provider: Option<String>,
    base_url: Option<String>,
    enabled: Option<bool>,
    key_change: Option<KeyChange>,
    discovery_id: Option<String>,
}

async fn update(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<Patch>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let admin = administrator(&service, &headers, true)?;
    let patch = body(request)?;
    run(move || update_sync(&service, admin.username(), id, patch)).await
}

fn update_sync(
    service: &DocumentService,
    actor: &str,
    id: String,
    patch: Patch,
) -> Result<StatusCode, ApiError> {
    let _guard = service.metadata.ai_guard()?;
    let mut db = service.metadata.connection()?;
    let tx = db.transaction()?;
    let mut old = connection(&tx, &id)?;
    if old.version != patch.expected_version {
        return Err(stale());
    }
    if patch.provider.as_deref().is_some_and(|p| p != "deepseek") {
        return Err(ApiError::invalid("Unsupported provider"));
    }
    if let Some(name) = patch.label {
        old.label = label(&name)?.to_owned();
    }
    let url = match patch.base_url {
        Some(s) => ai_provider::normalize(&s)?.to_string(),
        None => old.base_url.clone(),
    };
    match patch.key_change.unwrap_or(KeyChange::Keep) {
        KeyChange::Replace { api_key } => {
            let ticket = patch
                .discovery_id
                .as_deref()
                .ok_or_else(|| ApiError::invalid("Discover the models again"))?;
            old.catalog = service
                .ai_discovery
                .validate_discovery(actor, "deepseek", &url, &api_key, ticket)?;
            old.ciphertext = Some(ai_credentials::seal(
                &service.metadata.product_file("ai-install.key"),
                &id,
                &api_key,
            )?);
        }
        KeyChange::Clear => {
            old.ciphertext = None;
            old.enabled = false;
            old.catalog.models.clear();
        }
        KeyChange::Keep if url != old.base_url => {
            return Err(ApiError::invalid(
                "Enter a new credential for the changed address",
            ))
        }
        KeyChange::Keep => {}
    }
    old.base_url = url;
    if let Some(enable) = patch.enabled {
        if enable {
            old.secret(service)?;
            if old.catalog.models.is_empty() {
                return Err(ApiError::invalid(
                    "Discover models before enabling the connection",
                ));
            }
        }
        old.enabled = enable;
    }
    tx.execute("UPDATE ai_connections SET label=?1,base_url=?2,ciphertext=?3,enabled=?4,catalog=?5,version=version+1 WHERE id=?6",
        params![old.label,old.base_url,old.ciphertext,old.enabled,json!(old.catalog).to_string(),id])?;
    bump(&tx)?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    expected_version: i64,
}
async fn remove(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Expected>,
) -> Result<StatusCode, ApiError> {
    administrator(&service, &headers, true)?;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut db = service.metadata.connection()?;
        let tx = db.transaction()?;
        if connection(&tx, &id)?.version != q.expected_version {
            return Err(stale());
        }
        tx.execute("DELETE FROM ai_connections WHERE id=?1", [&id])?;
        bump(&tx)?;
        tx.commit()?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    selection: Option<ModelSelection>,
}
async fn preference(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    request: Result<Json<Choice>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let user = browser(&service, &headers, true)?;
    let choice = body(request)?.selection;
    run(move || preference_sync(&service, user.username(), choice)).await
}

fn preference_sync(
    service: &DocumentService,
    actor: &str,
    choice: Option<ModelSelection>,
) -> Result<StatusCode, ApiError> {
    let mut db = service.metadata.connection()?;
    let tx = db.transaction()?;
    if let Some(s) = choice {
        check_selection(service, &tx, &s, true)?;
        tx.execute("INSERT INTO ai_account_choices VALUES(?1,?2) ON CONFLICT(account) DO UPDATE SET selection=excluded.selection",params![actor,json!(s).to_string()])?;
    } else {
        tx.execute("DELETE FROM ai_account_choices WHERE account=?1", [actor])?;
    }
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

async fn default_choice(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    request: Result<Json<Choice>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    administrator(&service, &headers, true)?;
    let s = body(request)?
        .selection
        .ok_or_else(|| ApiError::invalid("Select a default model"))?;
    run(move || default_choice_sync(&service, s)).await
}

fn default_choice_sync(
    service: &DocumentService,
    s: ModelSelection,
) -> Result<StatusCode, ApiError> {
    let mut db = service.metadata.connection()?;
    let tx = db.transaction()?;
    check_selection(service, &tx, &s, true)?;
    let changed=tx.execute("UPDATE ai_configuration SET default_choice=?1,version=version+1 WHERE singleton=1 AND mode='managed'",[json!(s).to_string()])?;
    if changed == 0 {
        return Err(conflict(
            "managed_activation_required",
            "Enable managed AI first",
        ));
    }
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enabled {
    enabled: bool,
}
async fn global_enabled(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    request: Result<Json<Enabled>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    administrator(&service, &headers, true)?;
    let enabled = body(request)?.enabled;
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let db = service.metadata.connection()?;
        db.execute(
            "UPDATE ai_configuration SET enabled=?1,version=version+1 WHERE singleton=1",
            [enabled],
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

fn runner_online(db: &Connection) -> Result<bool, ApiError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_runner_instances WHERE last_seen >= unixepoch()-30)",
        [],
        |row| row.get(0),
    )?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    activation_id: String,
    expected_settings_version: i64,
    selection: ModelSelection,
}

async fn activate(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    request: Result<Json<Activation>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let admin = administrator(&service, &headers, true)?;
    let input = body(request)?;
    run(move || activate_sync(&service, admin.username(), input)).await
}

fn activate_sync(
    service: &DocumentService,
    actor: &str,
    input: Activation,
) -> Result<Json<Value>, ApiError> {
    if input.activation_id.trim().is_empty() || input.activation_id.len() > 128 {
        return Err(ApiError::invalid(
            "Provide an activation ID up to 128 bytes",
        ));
    }
    let _guard = service.metadata.ai_guard()?;
    let mut db = service.metadata.connection()?;
    let tx = db.transaction()?;
    let selection = json!(input.selection).to_string();
    let (version, mode): (i64, String) = tx.query_row(
        "SELECT version,mode FROM ai_configuration WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if mode == "managed" {
        let previous: Option<String> = tx.query_row(
            "SELECT receipt FROM ai_managed_activation WHERE singleton=1 AND actor=?1 AND activation_id=?2 AND expected_version=?3 AND selection=?4",
            params![actor,input.activation_id,input.expected_settings_version,selection],
            |r| r.get(0),
        ).optional()?;
        return match previous {
            Some(receipt) => Ok(Json(
                serde_json::from_str(&receipt).map_err(ApiError::internal)?,
            )),
            None => Err(conflict(
                "managed_already_active",
                "Managed AI was already activated",
            )),
        };
    }
    if version != input.expected_settings_version {
        return Err(stale());
    }
    check_selection(service, &tx, &input.selection, false)?;
    if !runner_online(&tx)? {
        return Err(conflict(
            "runner_offline",
            "Start the managed runner before activation",
        ));
    }
    tx.execute(
        "UPDATE ai_connections SET enabled=1,version=version+1 WHERE id=?1 AND enabled=0",
        [&input.selection.connection_id],
    )?;
    tx.execute(
        "UPDATE ai_configuration SET mode='managed', default_choice=?1, version=version+1 WHERE singleton=1",
        [&selection],
    )?;
    let receipt = json!({"activationId":input.activation_id,"dispatchMode":"managed","settingsVersion":version+1});
    tx.execute(
        "INSERT INTO ai_managed_activation(singleton,actor,activation_id,expected_version,selection,receipt) VALUES(1,?1,?2,?3,?4,?5)",
        params![actor,input.activation_id,version,selection,receipt.to_string()],
    )?;
    tx.commit()?;
    Ok(Json(receipt))
}
