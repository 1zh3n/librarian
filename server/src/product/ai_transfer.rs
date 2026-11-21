//! Global AI uses the same identity-, inventory- and access-bound plan as the directory.
use serde::{Deserialize, Serialize};

use super::{
    ai::{Confirmation, Mode, Operation, OperationStatus},
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::DocumentService,
    file_actions::{self, AccessChanges, ActionResult, Apply, Input, Kind},
};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum TransferKind {
    Move,
    Copy,
}

fn document() -> Kind {
    Kind::Document
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    kind: TransferKind,
    #[serde(default = "document")]
    source_kind: Kind,
    pub source_workspace_id: String,
    source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_id: Option<String>,
    pub target_workspace_id: String,
    target_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preview {
    #[serde(flatten)]
    request: Request,
    source_workspace_name: String,
    target_workspace_name: String,
    file_count: usize,
    access: AccessChanges,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    kind: TransferKind,
    workspace_id: String,
    workspace_name: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_id: Option<String>,
}

impl Request {
    fn input(&self) -> Input {
        Input {
            action: match self.kind {
                TransferKind::Move => file_actions::Action::Move,
                TransferKind::Copy => file_actions::Action::Copy,
            },
            source_kind: self.source_kind,
            source_path: self.source_path.clone(),
            expected_document_id: self.document_id.clone(),
            expected_folder_id: None,
            target_workspace: Some(self.target_workspace_id.clone()),
            target_path: Some(self.target_path.clone()),
        }
    }

    fn names(
        &self,
        service: &DocumentService,
        account: &Account,
    ) -> Result<(String, String), ApiError> {
        let (source, _) = service.scope(account, &self.source_workspace_id, false)?;
        let (target, _) = service.scope(account, &self.target_workspace_id, true)?;
        Ok((source.config.name.clone(), target.config.name.clone()))
    }
}

pub(super) fn preview(
    service: &DocumentService,
    account: &Account,
    op: &mut Operation,
    request: Request,
) -> Result<(), ApiError> {
    if !op.is_global()
        || op.view.mode != Mode::Edit
        || request.source_workspace_id == request.target_workspace_id
    {
        return Err(ApiError::invalid(
            "A transfer needs a global edit and two distinct workspaces",
        ));
    }
    match (request.source_kind, request.document_id.as_deref()) {
        (Kind::Folder, None) => (),
        (Kind::Document, Some(id)) if !id.is_empty() => (),
        _ => {
            return Err(ApiError::invalid(
                "Expected a stable ID for a document or a folder path",
            ))
        }
    }
    let accepted = op
        .accepted
        .as_ref()
        .filter(|r| r.edits.is_empty())
        .ok_or_else(|| ApiError::invalid("A transfer needs a dedicated edit operation"))?;
    let _guard = service.metadata.workspace_guard()?;
    op.ensure_owner(service, account, false)?;
    let input = request.input();
    let checked =
        file_actions::preview_action(service, account, &request.source_workspace_id, &input)?;
    let (source_workspace_name, target_workspace_name) = request.names(service, account)?;
    op.view.answer = Some(accepted.answer.clone());
    op.view.sources.clone_from(&accepted.sources);
    op.view.confirmation = Some(Confirmation {
        id: format!("{}.{}", op.view.id, checked.token),
        paths: vec![request.source_path.clone(), request.target_path.clone()],
        plan: None,
        transfer: Some(Preview {
            request,
            source_workspace_name,
            target_workspace_name,
            file_count: checked.file_count,
            access: checked.access,
        }),
    });
    op.view.status = OperationStatus::NeedsConfirmation;
    op.input = None;
    op.store(&service.metadata, true)
}

impl Preview {
    fn apply_request(&self, op: &Operation) -> Result<Apply, ApiError> {
        let token = op
            .view
            .confirmation
            .as_ref()
            .and_then(|c| c.id.split_once('.'))
            .filter(|(id, _)| *id == op.view.id)
            .map(|(_, token)| token)
            .ok_or_else(file_actions::changed)?;
        Ok(Apply {
            operation_id: op.view.id.clone(),
            token: token.to_owned(),
            input: self.request.input(),
        })
    }

    fn receipt(&self, result: ActionResult) -> Receipt {
        Receipt {
            kind: self.request.kind,
            workspace_id: result.workspace_id,
            workspace_name: self.target_workspace_name.clone(),
            path: result.path,
            document_id: result.document_id,
        }
    }
}

pub(super) fn execute(
    service: &DocumentService,
    account: &Account,
    op: &Operation,
    preview: &Preview,
) -> Result<Receipt, ApiError> {
    let _guard = service.metadata.workspace_guard()?;
    op.ensure_owner(service, account, false)?;
    let (source, target) = preview.request.names(service, account)?;
    if source != preview.source_workspace_name || target != preview.target_workspace_name {
        return Err(file_actions::changed());
    }
    let result = file_actions::apply_action(
        service,
        account,
        &preview.request.source_workspace_id,
        &preview.apply_request(op)?,
    )?;
    Ok(preview.receipt(result))
}

pub(super) fn recover(
    db: &Metadata,
    op: &Operation,
    preview: &Preview,
) -> Result<Option<Receipt>, ApiError> {
    let receipt = file_actions::storage::completed(
        db,
        &op.owner,
        &preview.request.source_workspace_id,
        &preview.apply_request(op)?,
    )?;
    Ok(receipt.map(|result| preview.receipt(result)))
}
