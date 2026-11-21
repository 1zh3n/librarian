use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

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
use tokio_stream::{Stream, StreamExt};
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

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum GlobalScope {
    Global,
}

pub(super) fn validate_scope(
    scope: Option<GlobalScope>,
    workspace: Option<&str>,
    document: Option<&str>,
) -> Result<(), ApiError> {
    match (scope, workspace, document) {
        (Some(GlobalScope::Global), None, None) => Ok(()),
        (None, Some(id), _) if !id.is_empty() => Ok(()),
        _ => Err(ApiError::invalid(
            "Specify a workspaceId or an explicit global scope",
        )),
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<GlobalScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub document_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<u32>,
    #[serde(flatten)]
    pub material: Option<super::ai_materials::Citation>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OperationView {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<GlobalScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_result: Option<super::ai_reorganization::WriteResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_result: Option<super::ai_transfer::Receipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_management: Option<super::ai_space_management::Receipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<super::ai_configuration::ModelSelection>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Confirmation {
    pub id: String,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<super::ai_reorganization::Plan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer: Option<super::ai_transfer::Preview>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lease {
    pub id: String,
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub provider_issued: bool,
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
    #[serde(default, rename = "runnerProtocol")]
    pub protocol: super::ai_managed::Protocol,
    #[serde(default, rename = "connectionVersion")]
    pub connection_version: Option<i64>,
    #[serde(default, rename = "queuedAt")]
    pub queued_at: i64,
    #[serde(default)]
    pub external: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rename_identities: Vec<super::workspace::RenameIdentity>,
    #[serde(
        default,
        rename = "workspaceDependencies",
        skip_serializing_if = "BTreeSet::is_empty"
    )]
    pub workspace_dependencies: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub write_targets: BTreeMap<String, String>,
    #[serde(default)]
    pub browser_management: bool,
    pub(super) owner: String,
    pub(super) credential_version: Option<String>,
    pub input: Option<TaskInput>,
    pub lease: Option<Lease>,
    pub delivered: Vec<SourceReference>,
    pub accepted: Option<AcceptedResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub management_action: Option<super::ai_space_management::Action>,
    pub result_fingerprint: Option<String>,
    undo_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decided: Option<Confirmation>,
}

impl OperationView {
    pub(super) fn mutation_workspace(&self) -> &str {
        self.target_workspace_id
            .as_deref()
            .unwrap_or(&self.workspace_id)
    }
}

impl Operation {
    pub(super) fn prepare(
        service: &DocumentService,
        account: &Account,
        input: TaskInput,
    ) -> Result<Self, ApiError> {
        let mut op = Self::new_operation(service, account, input)?;
        let db = service.metadata.connection()?;
        let (mode, enabled): (String, bool) = db.query_row(
            "SELECT mode,enabled FROM ai_configuration WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if !enabled {
            return Err(super::ai_managed::disabled());
        }
        if op.is_global() && mode != "managed" {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "managed_activation_required",
                "Global conversations require managed AI",
            ));
        }
        if mode == "managed" {
            if !super::ai_configuration::runner_online(&db)? {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "runner_offline",
                    "The managed runner is offline",
                ));
            }
            let choice =
                super::ai_configuration::resolve_selection(service, &db, account.username())?
                    .0
                    .ok_or_else(|| {
                        ApiError::new(
                            StatusCode::CONFLICT,
                            "model_unavailable",
                            "Choose a working AI connection",
                        )
                    })?;
            let version = super::ai_configuration::check_selection(service, &db, &choice, true)?;
            op.view.selection = Some(choice);
            op.protocol = super::ai_managed::Protocol::Managed;
            op.connection_version = Some(version);
        }
        Ok(op)
    }

    fn new_operation(
        service: &DocumentService,
        account: &Account,
        input: TaskInput,
    ) -> Result<Self, ApiError> {
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
        validate_scope(
            input.scope,
            input.workspace_id.as_deref(),
            input.document_id.as_deref(),
        )?;
        if let Some(workspace) = input.workspace_id.as_deref() {
            service.scope(account, workspace, input.mode == Mode::Edit)?;
            for id in input
                .document_id
                .iter()
                .chain(input.context.iter().map(|c| &c.document_id))
            {
                service.path_in(workspace, id)?;
            }
        } else if !input.context.is_empty() {
            return Err(ApiError::invalid(
                "Use workspace-qualified reads in a global task",
            ));
        }
        Ok(Self {
            protocol: super::ai_managed::Protocol::Legacy,
            connection_version: None,
            external: false,
            rename_identities: Vec::new(),
            queued_at: chrono::Utc::now().timestamp(),
            view: OperationView {
                id: Uuid::new_v4().to_string(),
                scope: input.scope,
                workspace_id: input.workspace_id.clone().unwrap_or_default(),
                target_workspace_id: None,
                document_id: input.document_id.clone(),
                mode: input.mode,
                status: OperationStatus::Queued,
                answer: None,
                sources: Vec::new(),
                commit_id: None,
                confirmation: None,
                undo_commit_id: None,
                changes: Vec::new(),
                write_result: None,
                transfer_result: None,
                workspace_management: None,
                selection: None,
            },
            owner: account.username().to_owned(),
            credential_version: service.spaces.users.credential_version(account.username()),
            workspace_dependencies: BTreeSet::new(),
            write_targets: BTreeMap::new(),
            browser_management: false,
            input: Some(input),
            lease: None,
            delivered: Vec::new(),
            accepted: None,
            result_fingerprint: None,
            management_action: None,
            decided: None,
            undo_id: Uuid::new_v4().to_string(),
        })
    }

    pub(super) fn new_edit(
        service: &DocumentService,
        account: &Account,
        workspace: &str,
        id: &str,
    ) -> Result<Self, ApiError> {
        if Uuid::parse_str(id).ok().is_none_or(|u| u.to_string() != id) {
            return Err(ApiError::invalid("Expected a canonical operation UUID"));
        }
        let input = TaskInput {
            scope: None,
            workspace_id: Some(workspace.into()),
            document_id: None,
            mode: Mode::Edit,
            prompt: "Workspace edit".into(),
            context: vec![],
        };
        let mut op = Self::new_operation(service, account, input)?;
        op.input = None;
        op.external = true;
        op.view.id = id.to_owned();
        op.view.status = OperationStatus::Running;
        Ok(op)
    }

    pub(super) fn undo(
        &mut self,
        service: &DocumentService,
        account: &Account,
    ) -> Result<MutationReceipt, ApiError> {
        self.ensure_owner(service, account, true)?;
        let Some(commit) = self.view.commit_id.as_deref() else {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "undo_unavailable",
                "There is no committed operation to undo",
            ));
        };
        let moved = self
            .decided
            .as_ref()
            .and_then(|c| c.plan.as_ref())
            .and_then(|plan| {
                super::ai_reorganization::undo_move(
                    service,
                    account,
                    self.view.mutation_workspace(),
                    &self.undo_id,
                    plan,
                    &self.rename_identities,
                )
            });
        let result = if let Some(receipt) = moved {
            receipt?
        } else {
            let _guard = service.metadata.workspace_guard()?;
            let (instance, actor) = service.scope(account, self.view.mutation_workspace(), true)?;
            let state = state(&instance)?;
            let engine = managed_engine(state)?;
            engine.with_managed_write(|transaction| {
                if let Some(prior) = mutations::receipt(
                    &service.metadata,
                    &self.undo_id,
                    self.view.mutation_workspace(),
                    account.username(),
                )? {
                    return Ok(prior);
                }
                super::ai_reorganization::check_undo_targets(service, state, &self.view)?;
                let mut edits = Vec::with_capacity(self.view.changes.len());
                for change in &self.view.changes {
                    let markdown = if let Some(before) = &change.before_revision {
                        let bytes = read::RevisionPath::Recorded(&change.path)
                            .bytes(engine.store(), commit, true)
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
                    workspace: self.view.mutation_workspace(),
                    account: account.username(),
                    operation: &self.undo_id,
                }
                .apply(transaction, edits)
            })?
        };
        if self.view.undo_commit_id.as_deref() != Some(&result.commit_id) {
            self.view.undo_commit_id = Some(result.commit_id.clone());
            self.store(&service.metadata, true)?;
        }
        Ok(result)
    }
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

    pub(super) fn claimable(
        db: &Metadata,
        now: i64,
        protocol: super::ai_managed::Protocol,
    ) -> Result<Vec<Self>, ApiError> {
        let connection = db.connection()?;
        let mut query = connection.prepare(
            "SELECT entry FROM ai_operations WHERE (status = 'queued'
             OR (status = 'running' AND expires_at <= ?1)) AND
             COALESCE(json_extract(entry,'$.runnerProtocol'),'legacy')=?2 ORDER BY rowid LIMIT 32",
        )?;
        let entries = query
            .query_map(params![now, protocol.name()], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        entries
            .iter()
            .map(|entry| serde_json::from_str(entry).map_err(ApiError::internal))
            .collect()
    }

    pub(super) fn store(&self, db: &Metadata, emit: bool) -> Result<(), ApiError> {
        let mut connection = db.connection()?;
        let tx = connection.transaction()?;
        self.store_in(&tx, emit)?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn store_in(&self, tx: &rusqlite::Transaction, emit: bool) -> Result<(), ApiError> {
        let entry = serde_json::to_string(self).map_err(ApiError::internal)?;
        tx.execute(
            "INSERT INTO ai_operations (id, workspace_id, status, lease_id, expires_at, entry)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, lease_id = excluded.lease_id,
                 expires_at = excluded.expires_at, entry = excluded.entry",
            params![
                self.view.id,
                (!self.is_global()).then_some(&self.view.workspace_id),
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
        Ok(())
    }

    pub(super) fn is_global(&self) -> bool {
        self.view.scope.is_some()
    }

    fn check_access(
        &self,
        service: &DocumentService,
        account: &Account,
        write: bool,
    ) -> Result<(), ApiError> {
        super::mcp_operations::check_original(service, self, account.username(), write)?;
        if self.is_global() {
            for workspace in &self.workspace_dependencies {
                service.scope(account, workspace, false)?;
            }
            if let Some(target) = self.view.target_workspace_id.as_deref() {
                service.scope(account, target, write)?;
            }
        } else {
            service.scope(account, &self.view.workspace_id, write)?;
        }
        Ok(())
    }

    pub(super) fn actor(
        &self,
        service: &DocumentService,
        write: bool,
    ) -> Result<Account, ApiError> {
        let spaces = if self.is_global() {
            service
                .spaces
                .manager
                .registry()
                .current()
                .instances
                .keys()
                .cloned()
                .collect()
        } else {
            BTreeSet::from([service.metadata.space_id(&self.view.workspace_id)?])
        };
        let account = Account::from_bound_identity(
            &service.spaces,
            &self.owner,
            self.credential_version.as_deref(),
            spaces,
        )?;
        self.check_access(service, &account, write)?;
        Ok(account)
    }

    pub(super) fn ensure_owner(
        &self,
        service: &DocumentService,
        account: &Account,
        write: bool,
    ) -> Result<(), ApiError> {
        if self.owner != account.username() {
            return Err(ApiError::not_found());
        }
        self.check_access(service, account, write)
    }

    pub(super) fn settle(
        &mut self,
        db: &Metadata,
        status: OperationStatus,
    ) -> Result<(), ApiError> {
        self.view.status = status;
        self.input = None;
        self.accepted = None;
        self.management_action = None;
        self.delivered.clear();
        self.view.confirmation = None;
        self.store(db, true)
    }

    /// An interrupted AI receipt can lag a durable filesystem commit. Reconcile
    /// it without issuing a second write or requiring the author's former role.
    pub(super) fn recover_committed(
        &mut self,
        service: &DocumentService,
    ) -> Result<bool, ApiError> {
        let db = &service.metadata;
        if self.view.status != OperationStatus::Running || self.accepted.is_none() {
            return Ok(false);
        }
        if let Some(preview) = self
            .view
            .confirmation
            .as_ref()
            .and_then(|c| c.transfer.as_ref())
        {
            let Some(receipt) = super::ai_transfer::recover(db, self, preview)? else {
                return Ok(false);
            };
            self.view.transfer_result = Some(receipt);
            self.decided = self.view.confirmation.take();
            self.finish_accepted(db)?;
            return Ok(true);
        }
        if self.management_action.is_some() {
            let Some(receipt) = super::ai_space_management::committed(service, self)? else {
                return Ok(false);
            };
            self.record_management(receipt);
            self.finish_accepted(db)?;
            return Ok(true);
        }
        let Some(receipt) = mutations::receipt(
            db,
            &self.view.id,
            self.view.mutation_workspace(),
            &self.owner,
        )?
        else {
            return Ok(false);
        };
        self.record_receipt(db, receipt)?;
        self.finish_accepted(db)?;
        Ok(true)
    }

    fn record_receipt(&mut self, db: &Metadata, receipt: MutationReceipt) -> Result<(), ApiError> {
        if self.view.confirmation.is_none() && self.decided.is_none() {
            self.view.write_result = Some(super::ai_reorganization::write_result(
                db,
                &receipt,
                &self.write_targets,
            )?);
        }
        self.decided = self.view.confirmation.take();
        self.view.commit_id = Some(receipt.commit_id);
        self.view.changes = receipt.changes;
        Ok(())
    }

    fn record_management(&mut self, receipt: super::ai_space_management::Receipt) {
        self.workspace_dependencies
            .insert(receipt.workspace_id.clone());
        self.view.workspace_management = Some(receipt);
    }

    fn confirmation_error(&mut self, db: &Metadata, error: ApiError) -> Result<(), ApiError> {
        // A storage failure can follow publication. Recover the durable decision on retry.
        if error.status().is_client_error() {
            self.view.status = if error.status() == StatusCode::CONFLICT {
                OperationStatus::Conflict
            } else {
                OperationStatus::NeedsConfirmation
            };
            self.store(db, true)?;
        }
        Err(error)
    }

    fn finish_accepted(&mut self, db: &Metadata) -> Result<(), ApiError> {
        let accepted = self.accepted.take().expect("accepted AI result");
        self.view.answer = Some(accepted.answer);
        self.view.sources = accepted.sources;
        self.settle(db, OperationStatus::Succeeded)
    }

    pub(super) fn apply_result(
        &mut self,
        service: &DocumentService,
        account: &Account,
    ) -> Result<(), ApiError> {
        if let Some(action) = self.management_action.as_ref() {
            match super::ai_space_management::apply(service, account, self, action) {
                Ok(receipt) => self.record_management(receipt),
                Err(error) => {
                    if error.status().is_client_error() {
                        self.result_fingerprint = None;
                        self.settle(&service.metadata, OperationStatus::Failed)?;
                    }
                    return Err(error);
                }
            }
            return self.finish_accepted(&service.metadata);
        }
        if let Some(preview) = self
            .view
            .confirmation
            .as_ref()
            .and_then(|c| c.transfer.as_ref())
        {
            match super::ai_transfer::execute(service, account, self, preview) {
                Ok(receipt) => self.view.transfer_result = Some(receipt),
                Err(error) => return self.confirmation_error(&service.metadata, error),
            }
            self.decided = self.view.confirmation.take();
            return self.finish_accepted(&service.metadata);
        }
        let accepted = self.accepted.as_ref().expect("accepted AI result");
        let plan = self
            .view
            .confirmation
            .as_ref()
            .and_then(|c| c.plan.as_ref());
        let result = if let Some(plan) = plan {
            super::ai_reorganization::execute(
                service,
                account,
                self.view.mutation_workspace(),
                &self.view.id,
                plan,
                &self.rename_identities,
            )
        } else if !accepted.edits.is_empty() {
            apply_edits(service, account, self, accepted.edits.clone())
        } else {
            return self.finish_accepted(&service.metadata);
        };
        match result {
            Ok(receipt) => self.record_receipt(&service.metadata, receipt)?,
            Err(error) if plan.is_some() => {
                return self.confirmation_error(&service.metadata, error)
            }
            Err(error) if error.status() == StatusCode::CONFLICT => {
                self.settle(&service.metadata, OperationStatus::Conflict)?;
                return Err(error);
            }
            Err(error) => return Err(error),
        }
        self.finish_accepted(&service.metadata)
    }
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/operations", get(list).post(create))
        .route("/ai/operations/{operation}", get(get_operation))
        .route("/ai/operations/{operation}/events", get(events))
        .route("/ai/operations/{operation}/diff", get(diff))
        .route("/ai/operations/{operation}/confirm", post(confirm))
        .route(
            "/ai/operations/{operation}/cancel",
            post(cancel_confirmation),
        )
        .route("/ai/operations/{operation}/undo", post(undo))
        .merge(super::ai_conversations::routes())
        .merge(super::ai_runner::routes())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationList {
    scope: Option<GlobalScope>,
    workspace_id: Option<String>,
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
        validate_scope(
            query.scope,
            query.workspace_id.as_deref(),
            query.document_id.as_deref(),
        )?;
        let _guard = service.metadata.ai_guard()?;
        super::ai_managed::sweep(&service)?;
        let _workspace_guard = service.metadata.workspace_guard()?;
        if let Some(ws) = &query.workspace_id {
            service.scope(&account, ws, false)?;
        }
        let ids = super::ai_conversations::readable_under_guard(
            &service,
            &account,
            query.scope.is_some(),
        )?;
        if let Some(document) = &query.document_id {
            if Some(service.metadata.document_path(document)?.0) != query.workspace_id {
                return Err(ApiError::not_found());
            }
        }
        let db = service.metadata.connection()?;
        let mut list = db.prepare(&format!(
            "SELECT entry FROM ai_operations o WHERE workspace_id IS ?1
               AND json_extract(entry, '$.owner') = ?2
               AND json_extract(entry, '$.view.documentId') IS ?3 AND {}
             ORDER BY rowid DESC LIMIT 50",
            super::ai_conversations::visible("?4")
        ))?;
        let entries = list
            .query_map(
                params![
                    query.workspace_id,
                    account.username(),
                    query.document_id,
                    ids
                ],
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
        let _guard = service.metadata.ai_guard()?;
        let mut op = Operation::prepare(&service, &account, input)?;
        op.browser_management = !headers.contains_key(axum::http::header::AUTHORIZATION);
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
        let _guard = service.metadata.ai_guard()?;
        let mut op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, false)?;
        super::ai_managed::reconcile(&service, &mut op)?;
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
        if op.view.status == OperationStatus::Succeeded
            && op
                .decided
                .as_ref()
                .is_some_and(|c| c.id == request.confirmation_id)
        {
            return Ok(Json(op.view));
        }
        if !op.external {
            super::ai_managed::check_operation(&service, &mut op)?;
        }
        if !matches!(
            op.view.status,
            OperationStatus::NeedsConfirmation | OperationStatus::Running
        ) || !op
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
        // Record the commit decision before the filesystem transaction so recovery,
        // cancel and delete can distinguish it from an unconfirmed proposal.
        op.view.status = OperationStatus::Running;
        op.store(&service.metadata, false)?;
        op.apply_result(&service, &account)?;
        Ok(Json(op.view))
    })
    .await
}

async fn cancel_confirmation(
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
        op.ensure_owner(&service, &account, false)?;
        if op.view.status == OperationStatus::Canceled
            && op
                .decided
                .as_ref()
                .is_some_and(|c| c.id == request.confirmation_id)
        {
            return Ok(Json(op.view));
        }
        if !matches!(
            op.view.status,
            OperationStatus::NeedsConfirmation | OperationStatus::Conflict
        ) || !op
            .view
            .confirmation
            .as_ref()
            .is_some_and(|c| c.id == request.confirmation_id)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "confirmation_invalid",
                "The requested confirmation is no longer valid",
            ));
        }
        op.decided = op.view.confirmation.take();
        op.settle(&service.metadata, OperationStatus::Canceled)?;
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
        let result = op.undo(&service, &account)?;
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
        let _guard = service.metadata.ai_guard()?;
        let mut op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, false)?;
        super::ai_managed::reconcile(&service, &mut op)?;
        let commit_id = op.view.commit_id.clone().ok_or_else(ApiError::not_found)?;
        if !op
            .view
            .changes
            .iter()
            .any(|change| change.path == query.path)
        {
            return Err(ApiError::not_found());
        }
        let (instance, _) = service.scope(&account, op.view.mutation_workspace(), false)?;
        let state = state(&instance)?;
        let _read = super::documents::product_read(state)?;
        let store = managed_engine(state)?.store();
        let diff = read::RevisionPath::Recorded(&query.path)
            .diff(store, &commit_id, false)
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

pub(super) fn managed_engine(
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
    op: &Operation,
    edits: Vec<MutationEdit>,
) -> Result<MutationReceipt, ApiError> {
    let _workspace_guard = service.metadata.workspace_guard()?;
    op.ensure_owner(service, account, true)?;
    let workspace = op.view.mutation_workspace();
    let (instance, actor) = service.scope(account, workspace, true)?;
    let state = state(&instance)?;
    managed_engine(state)?.with_managed_write(|transaction| {
        // Directory actions share this workspace lock. A byte-identical replacement
        // has a different document ID and cannot consume the earlier read proof.
        for (path, id) in &op.write_targets {
            let actual = service
                .path_in(workspace, id)
                .map_err(super::ai_reorganization::conflict_if_missing)?;
            if &actual != path && super::documents::outline_path(&actual) != *path {
                return Err(ApiError::conflict(None));
            }
        }
        MutationContext {
            metadata: &service.metadata,
            state,
            actor: &actor,
            workspace,
            account: account.username(),
            operation: &op.view.id,
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
    let stream_service = service.clone();
    let stream_id = id.clone();
    let sequences = run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut op = Operation::get(&service.metadata, &id)?;
        op.ensure_owner(&service, &account, false)?;
        super::ai_managed::reconcile(&service, &mut op)?;
        let db = service.metadata.connection()?;
        let mut query = db.prepare(
            "SELECT seq FROM ai_events WHERE operation_id=? AND seq>? ORDER BY seq LIMIT 256",
        )?;
        let rows = query
            .query_map(params![id, after], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await?;
    // Fetch the payload only when the client polls it. Both ACLs and the event itself
    // can change while a response is buffered (including conversation deletion).
    let stream = tokio_stream::iter(sequences).then(move |seq| {
        let service = stream_service.clone();
        let id = stream_id.clone();
        let headers = headers.clone();
        async move {
            let (kind, payload) = run(move || {
                let account = Account::authenticate(&service.spaces, &headers, false)?;
                let _guard = service.metadata.ai_guard()?;
                Operation::get(&service.metadata, &id)?.ensure_owner(&service, &account, false)?;
                Ok(service
                    .metadata
                    .connection()?
                    .query_row(
                        "SELECT kind,payload FROM ai_events WHERE operation_id=? AND seq=?",
                        params![id, seq],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?)
            })
            .await
            .ok()??;
            Some(Ok(Event::default()
                .id(seq.to_string())
                .event(kind)
                .data(payload)))
        }
    });
    Ok(Sse::new(stream.map_while(|event| event)))
}
