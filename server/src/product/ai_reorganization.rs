use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

use super::{
    ai::{self, Confirmation, Mode, Operation, OperationStatus, SourceReference},
    auth::Account,
    contract::{content_precondition, present_revision, ApiError},
    db::Metadata,
    documents::{
        is_document_path, outline_path, product_read, read_markdown, state, DocumentService,
    },
    mutations::{self, FileChange, MutationContext, MutationEdit, MutationReceipt},
    references, workspace,
};
use crate::{link_resolve::BasenameIndex, state::ServerState};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceEdit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, deserialize_with = "present_revision")]
    pub base_revision: Option<Option<String>>,
    pub markdown: String,
}

pub(super) fn resolve_path(
    service: &DocumentService,
    workspace: &str,
    path: Option<String>,
    document: Option<String>,
) -> Result<String, ApiError> {
    match (path, document) {
        (Some(path), None) => Ok(path),
        (None, Some(id)) => service.path_in(workspace, &id),
        _ => Err(ApiError::invalid("Specify exactly one path or documentId")),
    }
}

pub(super) fn verify_read<'a>(
    mut delivered: impl Iterator<Item = &'a SourceReference>,
    path: &str,
    revision: &str,
) -> Result<(), ApiError> {
    if delivered.any(|s| {
        s.material.is_none()
            && s.path == path
            && s.revision == revision
            && s.from.is_none()
            && s.block_id.is_none()
    }) {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "unverified_revision",
        "Read the whole current file before modifying it",
    ))
}

pub(super) fn resolve_edits(
    service: &DocumentService,
    workspace: &str,
    edits: Vec<WorkspaceEdit>,
    delivered: Option<&[SourceReference]>,
) -> Result<Vec<MutationEdit>, ApiError> {
    if edits.is_empty() || edits.len() > 32 {
        return Err(ApiError::invalid(
            "Expected between 1 and 32 workspace edits",
        ));
    }
    let mut resolved = Vec::with_capacity(edits.len());
    for edit in edits {
        let base_revision = content_precondition(edit.base_revision.as_ref())?.map(str::to_owned);
        if edit.document_id.is_some() && base_revision.is_none() {
            return Err(ApiError::invalid("Creating a document requires a path"));
        }
        let path = resolve_path(service, workspace, edit.path, edit.document_id)?;
        if let (Some(reads), Some(revision)) = (delivered, &base_revision) {
            verify_read(reads.iter(), &path, revision)?;
        }
        resolved.push(MutationEdit {
            path,
            base_revision,
            markdown: Some(edit.markdown),
        });
    }
    resolved.sort_by(|a, b| a.path.cmp(&b.path));
    mutations::validate_edits(&resolved)?;
    Ok(resolved)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WrittenDocument {
    pub document_id: String,
    pub path: String,
    pub reader_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WriteResult {
    pub created: usize,
    pub updated: usize,
    pub documents: Vec<WrittenDocument>,
}

fn document_for_edit(path: &str) -> String {
    path.strip_suffix(".outline.md")
        .map(|stem| format!("{stem}.md"))
        .unwrap_or_else(|| path.to_owned())
}

pub(super) fn global_write_targets(
    db: &Metadata,
    workspace: &str,
    edits: &[MutationEdit],
    delivered: &[SourceReference],
) -> Result<BTreeMap<String, String>, ApiError> {
    let mut conn = db.connection()?;
    let tx = conn.transaction()?;
    let mut targets = BTreeMap::new();
    for edit in edits {
        let path = document_for_edit(&edit.path);
        let id = Metadata::document_id_in(&tx, workspace, &path)?;
        if let Some(revision) = &edit.base_revision {
            verify_read(
                delivered.iter().filter(|s| {
                    s.workspace_id.as_deref() == Some(workspace) && s.document_id == id
                }),
                &edit.path,
                revision,
            )?;
        }
        targets.insert(edit.path.clone(), id);
    }
    tx.commit()?;
    Ok(targets)
}

pub(super) fn write_result(
    db: &Metadata,
    receipt: &MutationReceipt,
    targets: &BTreeMap<String, String>,
) -> Result<WriteResult, ApiError> {
    let mut result = WriteResult {
        created: 0,
        updated: 0,
        documents: vec![],
    };
    for change in &receipt.changes {
        if change.revision.is_none() {
            continue;
        }
        if change.before_revision.is_none() {
            result.created += 1;
        } else {
            result.updated += 1;
        }
        let path = document_for_edit(&change.path);
        if is_document_path(&path) {
            let document_id = match targets.get(&change.path) {
                Some(id) => id.clone(),
                None => db.document_id(&receipt.workspace_id, &path)?,
            };
            let reader_path = format!(
                "/workspaces/{}/documents/{document_id}",
                receipt.workspace_id
            );
            result.documents.push(WrittenDocument {
                document_id,
                path: change.path.clone(),
                reader_path,
            });
        }
    }
    Ok(result)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum ReorganizationRequest {
    Move { from: String, to: String },
    Delete { document_ids: Vec<String> },
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct PathLink {
    from: String,
    to: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Plan {
    pub request: ReorganizationRequest,
    pub changes: Vec<FileChange>,
    path_links: Vec<PathLink>,
    partial_links: bool,
}

fn delete_changes(
    service: &DocumentService,
    state: &ServerState,
    workspace: &str,
    ids: &[String],
) -> Result<Vec<FileChange>, ApiError> {
    if ids.is_empty() || ids.len() > 32 {
        return Err(ApiError::invalid(
            "Choose between 1 and 32 documents to delete",
        ));
    }
    let root = Path::new(&state.space_folder_path);
    let mut changes = Vec::new();
    let mut seen = BTreeSet::new();
    let mut total = 0;
    for id in ids {
        if !seen.insert(id) {
            return Err(ApiError::invalid("Choose each document only once"));
        }
        let path = service.path_in(workspace, id)?;
        let outline = outline_path(&path);
        for (path, required) in [(path, true), (outline, false)] {
            let Some(bytes) = mutations::current_bytes(root, state.space.as_ref(), &path)? else {
                if required {
                    return Err(ApiError::not_found());
                }
                continue;
            };
            total += bytes.len();
            if total > mutations::MAX_BATCH_BYTES {
                return Err(super::documents::too_large());
            }
            changes.push(FileChange {
                path,
                before_revision: Some(sha256_hex(&bytes)),
                revision: None,
            });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

fn path_links(
    state: &ServerState,
    changes: &[FileChange],
) -> Result<(Vec<PathLink>, bool), ApiError> {
    let affected: BTreeSet<_> = changes
        .iter()
        .filter(|c| c.before_revision.is_some())
        .map(|c| c.path.as_str())
        .collect();
    let mut files: Vec<_> = state
        .space
        .fetch_file_list()?
        .into_iter()
        .filter(|f| is_document_path(&f.name))
        .collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let index = BasenameIndex::from_paths(files.iter().map(|f| f.name.clone()));
    let mut partial = files.len() > 512;
    let mut budget = 16 * 1024 * 1024usize;
    let mut links = BTreeSet::new();
    for f in files.into_iter().take(512) {
        if usize::try_from(f.size).unwrap_or(usize::MAX) > budget {
            partial = true;
            continue;
        }
        let markdown = match read_markdown(state, &f.name) {
            Ok(m) => m,
            Err(e) if e.is_file_conflict() => {
                partial = true;
                continue;
            }
            Err(e) => return Err(e),
        };
        let Some(left) = budget.checked_sub(markdown.len()) else {
            partial = true;
            break;
        };
        budget = left;
        for to in references::linked_documents(&markdown, &f.name, &index) {
            if affected.contains(to.as_str()) || affected.contains(f.name.as_str()) {
                if links.len() >= 100 {
                    partial = true;
                    break;
                }
                links.insert((f.name.clone(), to));
            }
        }
    }
    Ok((
        links
            .into_iter()
            .map(|(from, to)| PathLink { from, to })
            .collect(),
        partial,
    ))
}

/// The caller holds ai_guard across accepting a result and publishing its preview.
pub(super) fn preview(
    service: &DocumentService,
    account: &Account,
    op: &mut Operation,
    request: ReorganizationRequest,
) -> Result<(), ApiError> {
    if op.view.mode != Mode::Edit || op.accepted.as_ref().is_some_and(|r| !r.edits.is_empty()) {
        return Err(ApiError::invalid(
            "Reorganization requires a dedicated edit operation",
        ));
    }
    let workspace = &op.view.workspace_id;
    let _guard = service.metadata.workspace_guard()?;
    let (instance, _) = service.scope(account, workspace, true)?;
    let state = state(&instance)?;
    ai::managed_engine(state)?;
    let _read = product_read(state)?;
    let changes = match &request {
        ReorganizationRequest::Delete { document_ids } => {
            delete_changes(service, state, workspace, document_ids)?
        }
        ReorganizationRequest::Move { from, to } => {
            workspace::require_manage(service, account, workspace)?;
            let (changes, identities) =
                workspace::preview_rename(state, &service.metadata, workspace, from, to)?;
            op.rename_identities = identities;
            changes
        }
    };
    let (path_links, partial_links) = path_links(state, &changes)?;
    let paths = changes.iter().map(|c| c.path.clone()).collect();
    let confirmation = Confirmation {
        id: Uuid::new_v4().to_string(),
        paths,
        transfer: None,
        plan: Some(Plan {
            request,
            changes,
            path_links,
            partial_links,
        }),
    };
    if let Some(result) = &op.accepted {
        op.view.answer = Some(result.answer.clone());
        op.view.sources.clone_from(&result.sources);
    } else {
        op.accepted = Some(ai::AcceptedResult {
            answer: String::new(),
            sources: vec![],
            edits: vec![],
        });
    }
    op.view.confirmation = Some(confirmation);
    op.view.status = OperationStatus::NeedsConfirmation;
    op.input = None;
    op.store(&service.metadata, true)
}

pub(super) fn execute(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    operation: &str,
    plan: &Plan,
    identities: &[workspace::RenameIdentity],
) -> Result<MutationReceipt, ApiError> {
    match &plan.request {
        ReorganizationRequest::Move { from, to } => workspace::conditional_rename(
            service,
            account,
            workspace,
            operation,
            from,
            to,
            workspace::ExpectedRename {
                changes: &plan.changes,
                identities,
                reverse: false,
            },
        ),
        ReorganizationRequest::Delete { document_ids } => {
            let _guard = service.metadata.workspace_guard()?;
            let (instance, actor) = service.scope(account, workspace, true)?;
            let state = state(&instance)?;
            ai::managed_engine(state)?.with_managed_write(|tx| {
                if let Some(receipt) =
                    mutations::receipt(&service.metadata, operation, workspace, account.username())?
                {
                    if receipt.changes == plan.changes {
                        return Ok(receipt);
                    }
                    return Err(ApiError::conflict(None));
                }
                let actual = delete_changes(service, state, workspace, document_ids)
                    .map_err(conflict_if_missing)?;
                if actual != plan.changes {
                    return Err(ApiError::conflict(None));
                }
                let edits = actual
                    .into_iter()
                    .map(|c| MutationEdit {
                        path: c.path,
                        base_revision: c.before_revision,
                        markdown: None,
                    })
                    .collect();
                MutationContext {
                    metadata: &service.metadata,
                    state,
                    actor: &actor,
                    workspace,
                    account: account.username(),
                    operation,
                }
                .apply_named(tx, edits, "Delete workspace documents")
            })
        }
    }
}

pub(super) fn conflict_if_missing(e: ApiError) -> ApiError {
    if e.status() == StatusCode::NOT_FOUND {
        ApiError::conflict(None)
    } else {
        e
    }
}

/// Called under the same mutation lock as the inverse commit.
pub(super) fn check_undo_targets(
    service: &DocumentService,
    state: &ServerState,
    view: &ai::OperationView,
) -> Result<(), ApiError> {
    if let Some(written) = &view.write_result {
        for doc in &written.documents {
            let path = service
                .path_in(view.mutation_workspace(), &doc.document_id)
                .map_err(conflict_if_missing)?;
            if doc.path != path && doc.path != outline_path(&path) {
                return Err(ApiError::conflict(None));
            }
        }
    }
    for change in &view.changes {
        if is_document_path(&change.path)
            && (change.before_revision.is_none() || change.revision.is_none())
        {
            let sidecar = outline_path(&change.path);
            if !view.changes.iter().any(|c| c.path == sidecar)
                && mutations::current_bytes(
                    Path::new(&state.space_folder_path),
                    state.space.as_ref(),
                    &sidecar,
                )?
                .is_some()
            {
                return Err(ApiError::conflict(None));
            }
        }
    }
    Ok(())
}

pub(super) fn undo_move(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    operation: &str,
    plan: &Plan,
    identities: &[workspace::RenameIdentity],
) -> Option<Result<MutationReceipt, ApiError>> {
    if let ReorganizationRequest::Move { from, to } = &plan.request {
        let inverse: Vec<_> = plan
            .changes
            .iter()
            .map(|c| FileChange {
                path: c.path.clone(),
                before_revision: c.revision.clone(),
                revision: c.before_revision.clone(),
            })
            .collect();
        Some(workspace::conditional_rename(
            service,
            account,
            workspace,
            operation,
            to,
            from,
            workspace::ExpectedRename {
                changes: &inverse,
                identities,
                reverse: true,
            },
        ))
    } else {
        None
    }
}
