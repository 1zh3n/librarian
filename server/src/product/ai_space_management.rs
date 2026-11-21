//! One global edit turn can perform one Reader workspace management action.
use axum::http::StatusCode;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::multi::config::MemberRole;

use super::{
    accounts,
    ai::{Mode, Operation},
    ai_managed::Protocol,
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::DocumentService,
    workspace,
};

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Action {
    CreateWorkspace {
        name: String,
    },
    RenameWorkspace {
        workspace_id: String,
        name: String,
    },
    SetWorkspaceMember {
        workspace_id: String,
        username: String,
        role: MemberRole,
    },
    RemoveWorkspaceMember {
        workspace_id: String,
        username: String,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Change {
    CreateWorkspace,
    RenameWorkspace,
    SetWorkspaceMember { username: String, role: MemberRole },
    RemoveWorkspaceMember { username: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub workspace_id: String,
    pub name: String,
    #[serde(flatten)]
    change: Change,
}

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_space_management (
        operation_id TEXT PRIMARY KEY REFERENCES ai_operations(id) ON DELETE CASCADE,
        account TEXT NOT NULL, action TEXT NOT NULL, name TEXT NOT NULL, receipt TEXT
    );",
    )
}

impl Action {
    pub(super) fn workspace(&self) -> Option<&str> {
        match self {
            Self::CreateWorkspace { .. } => None,
            Self::RenameWorkspace { workspace_id, .. }
            | Self::SetWorkspaceMember { workspace_id, .. }
            | Self::RemoveWorkspaceMember { workspace_id, .. } => Some(workspace_id),
        }
    }

    fn member_change(&self) -> bool {
        matches!(
            self,
            Self::SetWorkspaceMember { .. } | Self::RemoveWorkspaceMember { .. }
        )
    }

    fn change(&self) -> Change {
        match self {
            Self::CreateWorkspace { .. } => Change::CreateWorkspace,
            Self::RenameWorkspace { .. } => Change::RenameWorkspace,
            Self::SetWorkspaceMember { username, role, .. } => Change::SetWorkspaceMember {
                username: username.clone(),
                role: *role,
            },
            Self::RemoveWorkspaceMember { username, .. } => Change::RemoveWorkspaceMember {
                username: username.clone(),
            },
        }
    }
}

struct Entry {
    owner: String,
    action: Action,
    name: String,
    receipt: Option<Receipt>,
}

impl Entry {
    fn get(db: &Metadata, id: &str) -> Result<Option<Self>, ApiError> {
        let row = db.connection()?.query_row(
            "SELECT account, action, name, receipt FROM ai_space_management WHERE operation_id=?",
            [id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,Option<String>>(3)?))
        ).optional()?;
        row.map(|(owner, action, name, saved)| {
            Ok(Self {
                owner,
                name,
                action: serde_json::from_str(&action).map_err(ApiError::internal)?,
                receipt: saved
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(ApiError::internal)?,
            })
        })
        .transpose()
    }

    fn save_receipt(
        &self,
        db: &Metadata,
        id: &str,
        workspace_id: String,
    ) -> Result<Receipt, ApiError> {
        let receipt = Receipt {
            workspace_id,
            name: self.name.clone(),
            change: self.action.change(),
        };
        db.connection()?.execute(
            "UPDATE ai_space_management SET receipt=?2 WHERE operation_id=?1",
            params![
                id,
                serde_json::to_string(&receipt).map_err(ApiError::internal)?
            ],
        )?;
        Ok(receipt)
    }

    // Inspect the actual atomically published config without replaying the mutation
    // or requiring a former manager to retain their credentials or permissions.
    fn recover_under_guard(
        &self,
        service: &DocumentService,
        id: &str,
    ) -> Result<Option<Receipt>, ApiError> {
        if let Some(saved) = &self.receipt {
            return Ok(Some(saved.clone()));
        }
        let workspace_id = if let Some(workspace_id) = self.action.workspace() {
            let native_id = service.metadata.space_id(workspace_id)?;
            service
                .spaces
                .manager
                .instance(&native_id)
                .filter(|instance| {
                    workspace::last_management_operation(&instance.config) == Some(id)
                })
                .map(|_| workspace_id.to_owned())
        } else {
            let binding = uuid::Uuid::parse_str(id).map_err(ApiError::internal)?;
            workspace::recover_creation_under_guard(service, &self.owner, binding)?
        };
        workspace_id
            .map(|workspace_id| self.save_receipt(&service.metadata, id, workspace_id))
            .transpose()
    }
}

pub(super) fn committed(
    service: &DocumentService,
    op: &Operation,
) -> Result<Option<Receipt>, ApiError> {
    let _guard = service.metadata.workspace_guard()?;
    let Some(entry) = Entry::get(&service.metadata, &op.view.id)? else {
        return Ok(None);
    };
    if entry.owner != op.owner {
        return Err(ApiError::not_found());
    }
    entry.recover_under_guard(service, &op.view.id)
}

pub(super) fn apply(
    service: &DocumentService,
    account: &Account,
    op: &Operation,
    action: &Action,
) -> Result<Receipt, ApiError> {
    if !op.is_global() || op.view.mode != Mode::Edit || op.protocol != Protocol::Managed {
        return Err(ApiError::invalid(
            "Workspace management requires a global managed edit turn",
        ));
    }
    if action.member_change() && !op.browser_management {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "browser_session_required",
            "Sign in through the browser to manage workspace members",
        ));
    }
    let db = &service.metadata;
    let id = &op.view.id;
    let _guard = db.workspace_guard()?;
    if !service
        .spaces
        .users
        .session_is_current(account.username(), op.credential_version.as_deref())
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "The account credentials have changed",
        ));
    }
    op.ensure_owner(service, account, false)?;

    if let Some(prior) = Entry::get(db, id)? {
        if prior.owner != account.username() || &prior.action != action {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "result_changed",
                "This operation already submitted a different action",
            ));
        }
        if let Some(saved) = prior.recover_under_guard(service, id)? {
            service.scope(account, &saved.workspace_id, false)?;
            return Ok(saved);
        }
    }

    let target = action
        .workspace()
        .map(|ws| workspace::require_manage(service, account, ws))
        .transpose()?
        .map(|(i, _)| i);
    if let Some(previous) = target
        .as_ref()
        .and_then(|instance| workspace::last_management_operation(&instance.config))
    {
        // A following AI mutation may replace the one bounded receipt marker. Seal
        // an interrupted predecessor first. Manual changes preserve the marker.
        if let Some(previous_entry) = Entry::get(db, previous)? {
            if previous_entry.receipt.is_none()
                && previous_entry.action.workspace() == action.workspace()
            {
                previous_entry.recover_under_guard(service, previous)?;
            }
        }
    }

    let name = match action {
        Action::CreateWorkspace { name } | Action::RenameWorkspace { name, .. } => {
            workspace::name(name.clone())?
        }
        _ => target
            .as_ref()
            .ok_or_else(ApiError::not_found)?
            .config
            .name
            .clone(),
    };
    // A pending action without a published native marker can resume with the
    // current display name. A published action has already returned its historical name above.
    db.connection()?.execute(
        "INSERT INTO ai_space_management(operation_id,account,action,name) VALUES (?1,?2,?3,?4)
         ON CONFLICT(operation_id) DO UPDATE SET name=excluded.name",
        params![
            id,
            account.username(),
            serde_json::to_string(action).map_err(ApiError::internal)?,
            name
        ],
    )?;
    let entry = Entry {
        owner: account.username().to_owned(),
        action: action.clone(),
        name,
        receipt: None,
    };
    let workspace = match execute(service, account, id, &entry) {
        Ok(ws) => ws,
        Err(error) => {
            if error.status().is_client_error() {
                if let Some(saved) = entry.recover_under_guard(service, id)? {
                    return Ok(saved);
                }
                db.connection()?
                    .execute("DELETE FROM ai_space_management WHERE operation_id=?", [id])?;
            }
            return Err(error);
        }
    };
    entry.save_receipt(db, id, workspace)
}

fn execute(
    service: &DocumentService,
    account: &Account,
    id: &str,
    entry: &Entry,
) -> Result<String, ApiError> {
    match &entry.action {
        Action::CreateWorkspace { .. } => {
            let binding = uuid::Uuid::parse_str(id).map_err(ApiError::internal)?;
            let instance = workspace::create_under_guard(
                service,
                account,
                workspace::Create::native(entry.name.clone()),
                binding,
            )?;
            service.metadata.workspace_id(&instance.id)
        }
        Action::RenameWorkspace { workspace_id, .. } => {
            workspace::rename_under_guard(service, account, workspace_id, entry.name.clone(), id)?;
            Ok(workspace_id.clone())
        }
        Action::SetWorkspaceMember {
            workspace_id,
            username,
            role,
        } => {
            accounts::change_member_under_guard(
                service,
                account,
                workspace_id,
                username.clone(),
                Ok(Some(*role)),
                Some(id),
            )?;
            Ok(workspace_id.clone())
        }
        Action::RemoveWorkspaceMember {
            workspace_id,
            username,
        } => {
            accounts::change_member_under_guard(
                service,
                account,
                workspace_id,
                username.clone(),
                Ok(None),
                Some(id),
            )?;
            Ok(workspace_id.clone())
        }
    }
}
