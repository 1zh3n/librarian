use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{rejection::JsonRejection, Path as RoutePath, State},
    http::{HeaderMap, StatusCode},
    routing::{patch, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use silverbullet_server_common::{revision::sha256_hex, starter_kits::PreparedStarter};

use crate::{
    auth::{AccessLevel, Actor},
    multi::{
        config::SpaceConfig, data_root, instance::SpaceInstance, manager::ApiError as NativeError,
    },
    state::ServerState,
};

use super::{
    auth::Account,
    contract::{ApiError, Workspace, WorkspaceDefaults},
    db::Metadata,
    documents::{
        body, check_file_path, check_storage_recovery, is_document_path, outline_path,
        product_write, run, state, too_large, DocumentService,
    },
    mutations::{self, FileChange, FileEdit, MutationContext, MutationReceipt},
    security_levels::SecurityLevel,
};

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE workspaces ADD COLUMN owner TEXT;
         ALTER TABLE workspaces ADD COLUMN origin TEXT NOT NULL DEFAULT 'native'
           CHECK (origin IN ('native', 'delivery'));
         ALTER TABLE workspaces ADD COLUMN retention TEXT NOT NULL DEFAULT 'persistent'
           CHECK (retention IN ('persistent', 'temporary'));
         ALTER TABLE workspaces ADD COLUMN expires_at INTEGER;
         ALTER TABLE workspaces ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
         CREATE TABLE workspace_renames (
           operation_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           account TEXT NOT NULL,
           source_path TEXT NOT NULL,
           target_path TEXT NOT NULL,
           plan TEXT NOT NULL,
           commit_id TEXT
         );",
    )
}

pub(super) fn migrate_security(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE workspaces ADD COLUMN security_level TEXT NOT NULL DEFAULT 'internal'
           CHECK (security_level IN ('public', 'internal', 'confidential', 'secret'));",
    )
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Origin {
    #[default]
    Native,
    Delivery,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Delivery => "delivery",
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Retention {
    #[default]
    Persistent,
    Temporary,
}

impl Retention {
    fn as_str(self) -> &'static str {
        match self {
            Self::Persistent => "persistent",
            Self::Temporary => "temporary",
        }
    }
}

pub(super) struct WorkspaceInfo {
    pub owner: Option<String>,
    pub origin: Origin,
    pub retention: Retention,
    pub expires_at: Option<i64>,
    pub security_level: SecurityLevel,
}

pub(super) fn info(metadata: &Metadata, workspace: &str) -> Result<WorkspaceInfo, ApiError> {
    let (owner, origin, retention, expires_at, security_level) = metadata
        .connection()?
        .query_row(
            "SELECT owner, origin, retention, expires_at, security_level
             FROM workspaces WHERE id = ?1",
            [workspace],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(ApiError::not_found)?;
    Ok(WorkspaceInfo {
        owner,
        origin: match origin.as_str() {
            "native" => Origin::Native,
            "delivery" => Origin::Delivery,
            _ => return Err(ApiError::internal("Invalid workspace origin")),
        },
        retention: match retention.as_str() {
            "persistent" => Retention::Persistent,
            "temporary" => Retention::Temporary,
            _ => return Err(ApiError::internal("Invalid workspace retention")),
        },
        expires_at,
        security_level: SecurityLevel::from_db(&security_level)
            .ok_or_else(|| ApiError::internal("Invalid workspace security level"))?,
    })
}

pub(super) fn expired(expires_at: Option<i64>) -> bool {
    expires_at.is_some_and(|deadline| deadline <= chrono::Utc::now().timestamp())
}

pub(super) fn ensure_active(metadata: &Metadata, workspace: &str) -> Result<(), ApiError> {
    if expired(info(metadata, workspace)?.expires_at) {
        return Err(ApiError::not_found());
    }
    Ok(())
}

fn can_manage(service: &DocumentService, account: &Account, details: &WorkspaceInfo) -> bool {
    service.spaces.users.is_admin(account.username())
        || details.owner.as_deref() == Some(account.username())
}

pub(super) fn require_manage(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
) -> Result<(Arc<SpaceInstance>, Actor), ApiError> {
    let scope = service.scope(account, workspace, false)?;
    if !can_manage(service, account, &info(&service.metadata, workspace)?) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "workspace_manage_required",
            "Workspace management requires its creator or a server administrator",
        ));
    }
    Ok(scope)
}

pub(super) fn describe(
    service: &DocumentService,
    account: &Account,
    instance: &SpaceInstance,
    actor: &Actor,
) -> Result<Workspace, ApiError> {
    let id = service.metadata.workspace_id(&instance.id)?;
    let details = info(&service.metadata, &id)?;
    Ok(Workspace {
        id,
        space_id: instance.id.clone(),
        name: instance.config.name.clone(),
        origin: details.origin.as_str(),
        retention: details.retention.as_str(),
        expires_at: details.expires_at,
        revision_mode: super::revisions::mode(instance.revisions.as_deref()),
        can_write: actor.level == AccessLevel::Write,
        can_manage: can_manage(service, account, &details),
        security_level: details.security_level.as_str(),
        capabilities: details.security_level.capabilities(),
        defaults: WorkspaceDefaults {
            outline_enabled: false,
        },
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Create {
    name: String,
    #[serde(default)]
    origin: Origin,
    #[serde(default)]
    retention: Retention,
    expires_at: Option<i64>,
    #[serde(default)]
    security_level: SecurityLevel,
}

impl Create {
    pub(super) fn native(name: String) -> Self {
        Self {
            name,
            origin: Origin::Native,
            retention: Retention::Persistent,
            expires_at: None,
            security_level: SecurityLevel::Internal,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    name: Option<String>,
    retention: Option<Retention>,
    #[serde(default, deserialize_with = "present_expiry")]
    expires_at: Option<Option<i64>>,
    security_level: Option<SecurityLevel>,
    #[serde(default)]
    confirm_security_downgrade: bool,
}

fn present_expiry<'de, D: Deserializer<'de>>(value: D) -> Result<Option<Option<i64>>, D::Error> {
    Option::deserialize(value).map(Some)
}

pub(super) fn name(value: String) -> Result<String, ApiError> {
    let name = value.trim();
    if name.is_empty()
        || name.chars().count() > 120
        || name.chars().any(char::is_control)
        || matches!(name, "." | "..")
        || name.eq_ignore_ascii_case(".git")
        || data_root::is_reserved_top_level(name)
    {
        return Err(ApiError::invalid(
            "Expected a workspace name of 1 to 120 characters",
        ));
    }
    Ok(name.to_owned())
}

fn expiry(
    origin: Origin,
    retention: Retention,
    expires_at: Option<i64>,
) -> Result<Option<i64>, ApiError> {
    match (origin, retention, expires_at) {
        (_, Retention::Persistent, None) => Ok(None),
        (Origin::Delivery, Retention::Temporary, Some(at)) if !expired(Some(at)) => Ok(Some(at)),
        (_, Retention::Persistent, Some(_)) => {
            Err(ApiError::invalid("Persistent workspaces cannot expire"))
        }
        (Origin::Native, Retention::Temporary, _) => Err(ApiError::invalid(
            "Only delivery workspaces can be temporary",
        )),
        (Origin::Delivery, Retention::Temporary, _) => Err(ApiError::invalid(
            "Temporary workspaces require an expiry in the future",
        )),
    }
}

pub(super) fn sweep_due(service: &DocumentService) -> Result<(), ApiError> {
    let _workspace = service.metadata.workspace_guard()?;
    let due = {
        let connection = service.metadata.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, space_id FROM workspaces WHERE owner IS NOT NULL AND origin = 'delivery'
             AND retention = 'temporary' AND retired = 0 AND expires_at <= ?1 ORDER BY expires_at",
        )?;
        let rows = statement
            .query_map([chrono::Utc::now().timestamp()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    if due.is_empty() {
        return Ok(());
    }
    let quarantine = retention_directory(&service.metadata)?;
    for (workspace, space_id) in due {
        if let Err(error) = retire_workspace(service, &workspace, &space_id, &quarantine) {
            tracing::warn!(%workspace, ?error, "Temporary workspace cleanup deferred");
        }
    }
    Ok(())
}

fn retention_directory(metadata: &Metadata) -> Result<PathBuf, ApiError> {
    let path = metadata.retired_workspace_directory();
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("Missing metadata directory"))?;
    require_directory(parent)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(ApiError::internal(error)),
    }
    require_directory(&path)?;
    path.canonicalize().map_err(ApiError::internal)
}

fn retire_workspace(
    service: &DocumentService,
    workspace: &str,
    space_id: &str,
    quarantine: &Path,
) -> Result<(), ApiError> {
    let canonical_id = uuid::Uuid::parse_str(space_id).is_ok_and(|id| id.to_string() == space_id);
    if !canonical_id {
        return Err(ApiError::internal("Unexpected temporary workspace ID"));
    }
    let target = quarantine.join(space_id);
    let relative = format!("spaces/{space_id}");
    let root = quarantine
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| ApiError::internal("Missing workspace data root"))?;
    let manager = &service.spaces.manager;
    let quarantined = match fs::symlink_metadata(&target) {
        Ok(meta) if meta.is_dir() => true,
        Ok(_) => return Err(ApiError::internal("Invalid retired workspace directory")),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(ApiError::internal(error)),
    };
    if !quarantined {
        let Some(instance) = manager.instance(space_id) else {
            return mark_retired(&service.metadata, workspace);
        };
        let state = state(&instance)?;
        let _mutation = product_write(state)?;
        let source = retention_source(root, &relative, &instance, state)?;
        // File transfers and the core mutation journal may still need this folder on restart.
        let pending: bool = service.metadata.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM mutations WHERE workspace_id = ?1 AND state = 'pending')",
            [workspace],
            |row| row.get(0),
        )?;
        if pending
            || super::file_actions::storage::pending_retirement(&service.metadata, workspace)?
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_recovery_pending",
                "Workspace storage recovery is pending",
            ));
        }
        service.metadata.connection()?.execute(
            "UPDATE delivery_tokens SET revoked = 1 WHERE workspace_id = ?1",
            [workspace],
        )?;
        super::snapshots::retire_workspace(&service.metadata, state, workspace)?;
        retention_source(root, &relative, &instance, state)?;
        require_directory(quarantine)?;
        fs::rename(&source, &target).map_err(ApiError::internal)?;
        // Queued readers or revision workers which have the old instance must leave it alone.
        state.fs_guard.require_storage_recovery();
        #[cfg(unix)]
        {
            fs::File::open(quarantine)
                .and_then(|directory| directory.sync_all())
                .map_err(ApiError::internal)?;
            fs::File::open(root.join("spaces"))
                .and_then(|directory| directory.sync_all())
                .map_err(ApiError::internal)?;
        }
    }
    // Unregister after releasing the mutation lock so retiring workers can finish.
    if manager
        .instance(space_id)
        .is_some_and(|instance| instance.config.folder == relative)
    {
        manager.delete(space_id).map_err(native_error)?;
    }
    require_directory(quarantine)?;
    require_directory(&target)?;
    fs::remove_dir_all(&target).map_err(ApiError::internal)?;
    mark_retired(&service.metadata, workspace)
}

fn retention_source(
    root: &Path,
    relative: &str,
    instance: &SpaceInstance,
    state: &ServerState,
) -> Result<PathBuf, ApiError> {
    let expected = root.join(relative);
    require_directory(&root.join("spaces"))?;
    require_directory(&expected)?;
    if instance.config.folder != relative
        || Path::new(&state.space_folder_path)
            .canonicalize()
            .map_err(ApiError::internal)?
            != expected
    {
        return Err(ApiError::internal(
            "Unexpected temporary workspace storage path",
        ));
    }
    Ok(expected)
}

fn require_directory(path: &Path) -> Result<(), ApiError> {
    if !fs::symlink_metadata(path)
        .map_err(ApiError::internal)?
        .is_dir()
    {
        return Err(ApiError::internal(
            "Temporary workspace storage is not a real directory",
        ));
    }
    Ok(())
}

fn mark_retired(metadata: &Metadata, workspace: &str) -> Result<(), ApiError> {
    metadata.connection()?.execute(
        "UPDATE workspaces SET retired = 1 WHERE id = ?1",
        [workspace],
    )?;
    Ok(())
}

pub(super) fn native_error(error: NativeError) -> ApiError {
    match error {
        NativeError::NotFound => ApiError::not_found(),
        NativeError::Validation(_) | NativeError::Conflict(_) => ApiError::new(
            StatusCode::CONFLICT,
            "workspace_configuration_conflict",
            "The workspace conflicts with the current server configuration",
        ),
        NativeError::Internal(error) => ApiError::internal(error),
    }
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/workspaces", post(create))
        .route("/workspaces/{workspace}", patch(update))
        .route("/workspaces/{workspace}/rename", post(rename))
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<Create>, JsonRejection>,
) -> Result<(StatusCode, Json<Workspace>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let binding = uuid::Uuid::new_v4();
        let instance = create_under_guard(&service, &account, input, binding)?;
        let actor = account.actor(&service.spaces, &instance, false)?;
        describe(&service, &account, &instance, &actor)
    })
    .await
    .map(|workspace| (StatusCode::CREATED, Json(workspace)))
}

// The binding is part of the same durable native config write as creation.
// On an interrupted managed request it locates the space even before SQLite registration.
pub(super) fn create_under_guard(
    service: &DocumentService,
    account: &Account,
    input: Create,
    binding: uuid::Uuid,
) -> Result<Arc<SpaceInstance>, ApiError> {
    let name = name(input.name)?;
    let expires_at = expiry(input.origin, input.retention, input.expires_at)?;
    if !service.spaces.users.is_enabled(account.username()) {
        return Err(ApiError::not_found());
    }
    let prefix = format!("/librarian-space-{}", binding.simple());
    let config = serde_json::from_value(serde_json::json!({
        "name": name,
        "binding": {"prefix": prefix},
        "access": "none",
        "members": {(account.username()): {"role": "write", "runtimeApi": false}},
        "revisions": "managed",
    }))
    .map_err(ApiError::internal)?;
    let manager = &service.spaces.manager;
    let (space_id, _) = manager
        .create(config, PreparedStarter::None)
        .map_err(native_error)?;
    let instance = manager
        .instance(&space_id)
        .ok_or_else(ApiError::not_found)?;
    if let Err(error) = register_created(
        service,
        &instance,
        account.username(),
        input.origin,
        input.retention,
        expires_at,
        input.security_level,
    ) {
        if let Err(rollback) = manager.delete(&space_id) {
            tracing::error!(%space_id, ?rollback, "Could not revert workspace setup");
        }
        return Err(error);
    }
    Ok(instance)
}

// A managed create can stop after spaces.json publication, before registration in SQLite.
pub(super) fn recover_creation_under_guard(
    service: &DocumentService,
    owner: &str,
    binding: uuid::Uuid,
) -> Result<Option<String>, ApiError> {
    let prefix = format!("/librarian-space-{}", binding.simple());
    let registry = service.spaces.manager.registry().current();
    let Some(instance) = registry.instances.values().find(|space| {
        space.config.binding.host().is_none() && space.config.binding.prefix() == prefix
    }) else {
        return Ok(None);
    };
    register_created(
        service,
        instance,
        owner,
        Origin::Native,
        Retention::Persistent,
        None,
        SecurityLevel::Internal,
    )?;
    Ok(Some(service.metadata.workspace_id(&instance.id)?))
}

fn register_created(
    service: &DocumentService,
    instance: &SpaceInstance,
    owner: &str,
    origin: Origin,
    retention: Retention,
    expires_at: Option<i64>,
    security_level: SecurityLevel,
) -> Result<(), ApiError> {
    if super::revisions::mode(instance.revisions.as_deref()) != "managed" {
        return Err(ApiError::internal(
            "Could not initialize managed workspace versions",
        ));
    }
    service.metadata.connection()?.execute(
        "INSERT INTO workspaces
           (id, space_id, owner, origin, retention, expires_at, security_level)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(space_id) DO UPDATE SET owner = excluded.owner, origin = excluded.origin,
           retention = excluded.retention, expires_at = excluded.expires_at,
           security_level = excluded.security_level WHERE workspaces.owner IS NULL",
        params![
            format!("ws_{}", uuid::Uuid::new_v4().simple()),
            instance.id,
            owner,
            origin.as_str(),
            retention.as_str(),
            expires_at,
            security_level.as_str()
        ],
    )?;
    Ok(())
}

const LAST_MANAGEMENT_OPERATION: &str = "librarianManagementOperation";

pub(super) fn last_management_operation(config: &SpaceConfig) -> Option<&str> {
    config.extra.get(LAST_MANAGEMENT_OPERATION)?.as_str()
}

// Persisted atomically with the name/role in spaces.json. Ordinary Reader changes
// preserve this field. A new managed action seals its predecessor's receipt first.
pub(super) fn mark_management_operation(config: &mut SpaceConfig, operation_id: Option<&str>) {
    if let Some(id) = operation_id {
        config
            .extra
            .insert(LAST_MANAGEMENT_OPERATION.to_owned(), id.into());
    }
}

async fn update(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    input: Result<Json<Update>, JsonRejection>,
) -> Result<Json<Workspace>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        update_under_guard(&service, &account, &workspace, input, None)
    })
    .await
    .map(Json)
}

pub(super) fn rename_under_guard(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    new_name: String,
    operation_id: &str,
) -> Result<Workspace, ApiError> {
    update_under_guard(
        service,
        account,
        workspace,
        Update {
            name: Some(new_name),
            retention: None,
            expires_at: None,
            security_level: None,
            confirm_security_downgrade: false,
        },
        Some(operation_id),
    )
}

fn update_under_guard(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    input: Update,
    operation_id: Option<&str>,
) -> Result<Workspace, ApiError> {
    let (instance, _) = require_manage(service, account, workspace)?;
    let details = info(&service.metadata, workspace)?;
    let retention = input.retention.unwrap_or(details.retention);
    let expires_at = match (retention, input.expires_at) {
        (_, Some(explicit)) => expiry(details.origin, retention, explicit)?,
        (Retention::Persistent, None) => None,
        (Retention::Temporary, None) if details.retention == Retention::Temporary => {
            details.expires_at
        }
        (Retention::Temporary, None) => expiry(details.origin, retention, None)?,
    };
    if let Some(name) = input
        .name
        .map(name)
        .transpose()?
        .filter(|name| *name != instance.config.name || operation_id.is_some())
    {
        let mut config = instance.config.clone();
        config.name = name;
        mark_management_operation(&mut config, operation_id);
        service
            .spaces
            .manager
            .update(&instance.id, config)
            .map_err(native_error)?;
    }
    if retention != details.retention || expires_at != details.expires_at {
        service.metadata.connection()?.execute(
            "UPDATE workspaces SET retention = ?2, expires_at = ?3 WHERE id = ?1",
            params![workspace, retention.as_str(), expires_at],
        )?;
    }
    let security_level = input.security_level.unwrap_or(details.security_level);
    if security_level != details.security_level {
        if security_level.rank() < details.security_level.rank()
            && !input.confirm_security_downgrade
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "security_downgrade_confirmation_required",
                "Lowering the workspace security level requires confirmation",
            ));
        }
        let mut connection = service.metadata.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE workspaces SET security_level = ?2 WHERE id = ?1",
            params![workspace, security_level.as_str()],
        )?;
        let audit_metadata = serde_json::json!({
            "from": details.security_level.as_str(),
            "to": security_level.as_str(),
        });
        super::audit::record_in(
            &transaction,
            super::audit::Event {
                actor: Some(account.username()),
                workspace: Some(workspace),
                action: "workspace.security_level.change",
                target: Some("security_level"),
                result: "ok",
                rule_id: None,
                request_id: operation_id,
                metadata: Some(&audit_metadata),
            },
        )?;
        transaction.commit()?;
    }
    let (instance, actor) = service.scope(account, workspace, false)?;
    describe(service, account, &instance, &actor)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rename {
    operation_id: String,
    from: String,
    to: String,
    expected_document_id: Option<String>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct PathMove {
    from: String,
    to: String,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct RenamePlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_document_id: Option<String>,
    documents: Vec<PathMove>,
    changes: Vec<FileChange>,
}

struct RenameIntent {
    operation: String,
    workspace: String,
    account: String,
    from: String,
    to: String,
    plan: RenamePlan,
    commit: Option<String>,
}

impl RenameIntent {
    const SELECT: &str = "SELECT operation_id, workspace_id, account, source_path, target_path, plan, commit_id FROM workspace_renames";

    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let plan = serde_json::from_str(&row.get::<_, String>(5)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok(Self {
            operation: row.get(0)?,
            workspace: row.get(1)?,
            account: row.get(2)?,
            from: row.get(3)?,
            to: row.get(4)?,
            plan,
            commit: row.get(6)?,
        })
    }

    fn get(metadata: &Metadata, operation: &str) -> Result<Option<Self>, ApiError> {
        Ok(metadata
            .connection()?
            .query_row(
                &format!("{} WHERE operation_id = ?1", Self::SELECT),
                [operation],
                Self::from_row,
            )
            .optional()?)
    }

    fn begin(&self, metadata: &Metadata) -> Result<(), ApiError> {
        let plan = serde_json::to_string(&self.plan).map_err(ApiError::internal)?;
        let mut connection = metadata.connection()?;
        let transaction = connection.transaction()?;
        for path in &self.plan.documents {
            let occupied: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE workspace_id = ?1 AND path = ?2)",
                params![self.workspace, path.to],
                |row| row.get(0),
            )?;
            if occupied {
                return Err(path_conflict());
            }
        }
        transaction.execute(
            "INSERT INTO workspace_renames (operation_id, workspace_id, account, source_path, target_path, plan)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![self.operation, self.workspace, self.account, self.from, self.to, plan],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn finish(&self, metadata: &Metadata, receipt: &MutationReceipt) -> Result<(), ApiError> {
        if receipt.workspace_id != self.workspace
            || receipt.operation_id != self.operation
            || receipt.changes != self.plan.changes
        {
            return Err(operation_reused());
        }
        let mut connection = metadata.connection()?;
        let transaction = connection.transaction()?;
        for path in &self.plan.documents {
            transaction.execute(
                "UPDATE documents SET path = ?3 WHERE workspace_id = ?1 AND path = ?2",
                params![self.workspace, path.from, path.to],
            )?;
        }
        transaction.execute(
            "UPDATE workspace_renames SET commit_id = ?2 WHERE operation_id = ?1",
            params![self.operation, receipt.commit_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn completed(&self) -> Option<MutationReceipt> {
        Some(MutationReceipt {
            operation_id: self.operation.clone(),
            workspace_id: self.workspace.clone(),
            commit_id: self.commit.clone()?,
            changes: self.plan.changes.clone(),
        })
    }
}

fn recover_renames(metadata: &Metadata) -> Result<(), ApiError> {
    let pending = {
        let connection = metadata.connection()?;
        let mut statement =
            connection.prepare(&format!("{} WHERE commit_id IS NULL", RenameIntent::SELECT))?;
        let rows = statement
            .query_map([], RenameIntent::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for intent in pending {
        if let Some(receipt) = mutations::receipt(
            metadata,
            &intent.operation,
            &intent.workspace,
            &intent.account,
        )? {
            intent.finish(metadata, &receipt)?;
        } else {
            metadata.connection()?.execute(
                "DELETE FROM workspace_renames WHERE operation_id = ?1",
                [&intent.operation],
            )?;
        }
    }
    Ok(())
}

pub(super) fn recover_startup(metadata: &Metadata) -> Result<(), String> {
    recover_renames(metadata)
        .map_err(|error| format!("Could not recover workspace renames: {error:?}"))
}

async fn rename(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    input: Result<Json<Rename>, JsonRejection>,
) -> Result<Json<MutationReceipt>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || rename_locked(&service, &account, &workspace, input, None))
        .await
        .map(Json)
}

#[derive(Serialize, Deserialize)]
pub(super) struct RenameIdentity {
    id: String,
    from: String,
    to: String,
}

pub(super) struct ExpectedRename<'a> {
    pub changes: &'a [FileChange],
    pub identities: &'a [RenameIdentity],
    pub reverse: bool,
}

pub(super) fn conditional_rename(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    operation: &str,
    from: &str,
    to: &str,
    expected: ExpectedRename<'_>,
) -> Result<MutationReceipt, ApiError> {
    rename_locked(
        service,
        account,
        workspace,
        Rename {
            operation_id: operation.to_owned(),
            from: from.to_owned(),
            to: to.to_owned(),
            expected_document_id: None,
        },
        Some(expected),
    )
}

fn rename_locked(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    input: Rename,
    expected: Option<ExpectedRename<'_>>,
) -> Result<MutationReceipt, ApiError> {
    let _guard = service.metadata.workspace_guard()?;
    let (instance, actor) = require_manage(service, account, workspace)?;
    if actor.level < AccessLevel::Write {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "read_only",
            "Workspace is read-only for this account",
        ));
    }
    let canonical_operation = uuid::Uuid::parse_str(&input.operation_id)
        .ok()
        .is_some_and(|id| id.to_string() == input.operation_id);
    if !canonical_operation {
        return Err(ApiError::invalid("Expected a canonical operation UUID"));
    }
    validate_move(&input.from, &input.to)?;
    let state = state(&instance)?;
    let engine = state
        .revisions
        .as_deref()
        .filter(|engine| engine.store().auto_commit_allowed())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "revisions_read_only",
                "Renaming requires managed workspace versions",
            )
        })?;
    engine.with_managed_write(|transaction| {
        check_storage_recovery(state)?;
        let metadata = &service.metadata;
        let existing = RenameIntent::get(metadata, &input.operation_id)?;
        if let Some(intent) = &existing {
            if intent.workspace != workspace
                || intent.account != account.username()
                || intent.from != input.from
                || intent.to != input.to
                || intent.plan.expected_document_id != input.expected_document_id
            {
                return Err(operation_reused());
            }
            if let Some(receipt) = intent.completed() {
                return Ok(receipt);
            }
        }
        if let Some(receipt) =
            mutations::receipt(metadata, &input.operation_id, workspace, account.username())?
        {
            let intent = existing.ok_or_else(operation_reused)?;
            intent.finish(metadata, &receipt)?;
            return Ok(receipt);
        }
        if let Some(id) = &input.expected_document_id {
            let matches_source: bool = metadata.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE workspace_id = ?1 AND path = ?2 AND id = ?3)",
                params![workspace, input.from, id],
                |row| row.get(0),
            )?;
            if !matches_source || !attributes(state, &input.from)?.is_some_and(|file| file.is_file()) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "rename_source_changed",
                    "The selected document is no longer at the source path",
                ));
            }
        }
        let (plan, edits) = plan_rename(state, &input.from, &input.to, input.expected_document_id).map_err(|e| {
            if expected.is_some() {
                super::ai_reorganization::conflict_if_missing(e)
            } else {
                e
            }
        })?;
        if let Some(expected) = expected {
            if expected.changes != plan.changes {
                return Err(ApiError::conflict(None));
            }
            for entry in expected.identities {
                let (ws, current_path) = metadata
                    .document_path(&entry.id)
                    .map_err(super::ai_reorganization::conflict_if_missing)?;
                let expected_path = if expected.reverse {
                    &entry.to
                } else {
                    &entry.from
                };
                if ws != workspace || &current_path != expected_path {
                    return Err(ApiError::conflict(None));
                }
            }
        }
        let intent = if let Some(intent) = existing {
            if intent.plan != plan {
                return Err(ApiError::conflict(None));
            }
            intent
        } else {
            let intent = RenameIntent {
                operation: input.operation_id,
                workspace: workspace.to_owned(),
                account: account.username().to_owned(),
                from: input.from,
                to: input.to,
                plan,
                commit: None,
            };
            intent.begin(metadata)?;
            intent
        };
        let context = MutationContext {
            metadata,
            state,
            actor: &actor,
            workspace,
            account: account.username(),
            operation: &intent.operation,
        };
        let receipt = context.apply_files(transaction, edits, "Rename workspace files")?;
        if let Err(error) = intent.finish(metadata, &receipt) {
            state.fs_guard.require_storage_recovery();
            return Err(error);
        }
        Ok(receipt)
    })
}

fn validate_move(from: &str, to: &str) -> Result<(), ApiError> {
    validate_path(from)?;
    validate_path(to)?;
    if from == to || path_suffix(from, to).is_some() || path_suffix(to, from).is_some() {
        return Err(ApiError::invalid(
            "Source and destination paths must not overlap",
        ));
    }
    Ok(())
}

pub(super) fn preview_rename(
    state: &ServerState,
    metadata: &Metadata,
    workspace: &str,
    from: &str,
    to: &str,
) -> Result<(Vec<FileChange>, Vec<RenameIdentity>), ApiError> {
    validate_move(from, to)?;
    let (plan, _) = plan_rename(state, from, to, None)?;
    let mut identities = Vec::with_capacity(plan.documents.len());
    for document in plan.documents {
        let id = metadata.document_id(workspace, &document.from)?;
        identities.push(RenameIdentity {
            id,
            from: document.from,
            to: document.to,
        });
    }
    Ok((plan.changes, identities))
}

fn path_suffix<'a>(prefix: &str, path: &'a str) -> Option<&'a str> {
    path.strip_prefix(prefix)?.strip_prefix('/')
}

fn validate_path(path: &str) -> Result<(), ApiError> {
    if !mutations::valid_file_path(path)
        || data_root::reserved(path)
        || path
            .split('/')
            .any(|part| data_root::reserved_dir(part).is_some())
    {
        return Err(ApiError::invalid("Expected a safe relative workspace path"));
    }
    Ok(())
}

fn attributes(state: &ServerState, path: &str) -> Result<Option<fs::Metadata>, ApiError> {
    check_file_path(state, path)?;
    match fs::symlink_metadata(Path::new(&state.space_folder_path).join(path)) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) if error.kind() == ErrorKind::NotADirectory => Err(path_conflict()),
        Err(error) => Err(ApiError::internal(error)),
    }
}

fn move_paths(state: &ServerState, from: &str, to: &str) -> Result<Vec<PathMove>, ApiError> {
    let source = attributes(state, from)?.ok_or_else(ApiError::not_found)?;
    if attributes(state, to)?.is_some() {
        return Err(path_conflict());
    }
    if source.is_file() {
        if !is_document_path(from) || !is_document_path(to) {
            return Err(ApiError::invalid(
                "Individual renames require Markdown document paths",
            ));
        }
        let (outline_from, outline_to) = (outline_path(from), outline_path(to));
        if attributes(state, &outline_to)?.is_some() {
            return Err(path_conflict());
        }
        let mut paths = vec![PathMove {
            from: from.to_owned(),
            to: to.to_owned(),
        }];
        if let Some(outline) = attributes(state, &outline_from)? {
            if !outline.is_file() {
                return Err(ApiError::invalid("Expected a regular outline file"));
            }
            paths.push(PathMove {
                from: outline_from,
                to: outline_to,
            });
        }
        return Ok(paths);
    }
    if !source.is_dir() {
        return Err(ApiError::invalid("Expected a document or directory"));
    }
    let root = Path::new(&state.space_folder_path);
    let mut paths = Vec::new();
    let mut pending = vec![from.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(root.join(&directory)).map_err(ApiError::internal)? {
            let entry = entry.map_err(ApiError::internal)?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| ApiError::invalid("Directory names must be UTF-8"))?;
            let old = format!("{directory}/{name}");
            validate_path(&old)?;
            let kind = entry.file_type().map_err(ApiError::internal)?;
            if kind.is_dir() {
                pending.push(old);
                continue;
            }
            if !kind.is_file() {
                return Err(ApiError::invalid(
                    "Directory contains a link or special file",
                ));
            }
            let tail = path_suffix(from, &old)
                .ok_or_else(|| ApiError::internal("Invalid directory suffix"))?;
            let new = format!("{to}/{tail}");
            validate_path(&new)?;
            if paths.len() == mutations::MAX_FILES / 2 {
                return Err(too_large());
            }
            paths.push(PathMove { from: old, to: new });
        }
    }
    if paths.is_empty() {
        return Err(ApiError::invalid(
            "Directory does not contain files to rename",
        ));
    }
    paths.sort_unstable_by(|a, b| a.from.cmp(&b.from));
    Ok(paths)
}

fn plan_rename(
    state: &ServerState,
    from: &str,
    to: &str,
    expected_document_id: Option<String>,
) -> Result<(RenamePlan, Vec<FileEdit>), ApiError> {
    let root = Path::new(&state.space_folder_path);
    let paths = move_paths(state, from, to)?;
    let mut files = Vec::with_capacity(2 * paths.len());
    let mut changes = Vec::with_capacity(2 * paths.len());
    let mut documents = Vec::new();
    let mut total_bytes = 0;
    for path in paths {
        let contents = mutations::current_bytes(root, state.space.as_ref(), &path.from)?
            .ok_or_else(ApiError::not_found)?;
        total_bytes += contents.len();
        if total_bytes > mutations::MAX_BATCH_BYTES {
            return Err(too_large());
        }
        let revision = sha256_hex(&contents);
        for (path, before_revision, after_revision, contents) in [
            (&path.from, Some(revision.clone()), None, None),
            (&path.to, None, Some(revision), Some(contents)),
        ] {
            files.push(FileEdit {
                path: path.clone(),
                base_revision: before_revision.clone(),
                contents,
            });
            changes.push(FileChange {
                path: path.clone(),
                before_revision,
                revision: after_revision,
            });
        }
        if is_document_path(&path.from) {
            documents.push(path);
        }
    }
    changes.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok((
        RenamePlan {
            expected_document_id,
            documents,
            changes,
        },
        files,
    ))
}

fn path_conflict() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "path_exists",
        "The destination path already exists",
    )
}

fn operation_reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "operation_id_reused",
        "Operation ID was used for a different request",
    )
}
