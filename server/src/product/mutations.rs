use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

use axum::http::StatusCode;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::{
    revision::sha256_hex, space::DiskSpacePrimitives, FileMeta, SpaceError, SpacePrimitives,
};

use crate::{
    auth::Actor,
    multi::{config::MultiConfig, instance::resolve_folder},
    revisions::{
        discover_repo_root,
        engine::ManagedWrite,
        store::{OperationFile, OperationGit},
    },
    state::ServerState,
};

use super::{
    contract::ApiError,
    db::Metadata,
    documents::{
        check_native_path, check_storage_recovery, is_document_path, note_file_write, too_large,
        MARKDOWN_LIMIT,
    },
};

const MAX_FILES: usize = 64;
const MAX_BATCH_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MutationEdit {
    pub path: String,
    pub base_revision: Option<String>,
    pub markdown: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MutationReceipt {
    pub operation_id: String,
    pub workspace_id: String,
    pub commit_id: String,
    pub changes: Vec<FileChange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileChange {
    pub path: String,
    pub before_revision: Option<String>,
    pub revision: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    git: OperationGit,
    root: PathBuf,
    changes: Vec<FileChange>,
}

struct Journal {
    id: String,
    workspace: String,
    account: String,
    fingerprint: String,
    status: String,
    attempted: usize,
    manifest: Manifest,
}

impl Journal {
    fn receipt(&self) -> MutationReceipt {
        MutationReceipt {
            operation_id: self.id.clone(),
            workspace_id: self.workspace.clone(),
            commit_id: self.manifest.git.commit_id.clone(),
            changes: self.manifest.changes.clone(),
        }
    }

    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let manifest: String = row.get(6)?;
        let manifest = serde_json::from_str(&manifest).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok(Self {
            id: row.get(0)?,
            workspace: row.get(1)?,
            account: row.get(2)?,
            fingerprint: row.get(3)?,
            status: row.get(4)?,
            attempted: row.get::<_, u32>(5)? as usize,
            manifest,
        })
    }

    fn get(metadata: &Metadata, operation: &str) -> Result<Option<Self>, ApiError> {
        Ok(metadata
            .connection()?
            .query_row(
                "SELECT * FROM mutations WHERE operation_id = ?1",
                [operation],
                Self::from_row,
            )
            .optional()?)
    }

    fn begin(&self, metadata: &Metadata) -> Result<(), ApiError> {
        let manifest = serde_json::to_string(&self.manifest).map_err(ApiError::internal)?;
        let inserted = metadata.connection()?.execute(
            "INSERT INTO mutations (operation_id, workspace_id, account, fingerprint, state, manifest)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5) ON CONFLICT(operation_id) DO NOTHING",
            params![self.id, self.workspace, self.account, self.fingerprint, manifest],
        )?;
        if inserted == 0 {
            return Err(operation_id_reused());
        }
        Ok(())
    }

    fn attempt(&mut self, metadata: &Metadata, count: usize) -> Result<(), ApiError> {
        metadata.connection()?.execute(
            "UPDATE mutations SET attempted = ?2 WHERE operation_id = ?1",
            params![self.id, count as u32],
        )?;
        self.attempted = count;
        Ok(())
    }

    fn finish(&self, metadata: &Metadata, status: Option<&str>) -> Result<(), ApiError> {
        let connection = metadata.connection()?;
        if let Some(status) = status {
            connection.execute(
                "UPDATE mutations SET state = ?2 WHERE operation_id = ?1",
                params![self.id, status],
            )?;
        } else {
            connection.execute("DELETE FROM mutations WHERE operation_id = ?1", [&self.id])?;
        }
        if status != Some("conflict") {
            let materials = metadata.operation_directory(&self.id);
            if let Err(error) = remove_materials(&materials) {
                tracing::warn!("Could not clean Librarian recovery materials: {error}");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Checkpoint {
    BeforeWrite(usize),
    BeforePublish,
    AfterPublish,
}

pub(super) struct MutationContext<'a> {
    pub metadata: &'a Metadata,
    pub state: &'a ServerState,
    pub actor: &'a Actor,
    pub workspace: &'a str,
    pub account: &'a str,
    pub operation: &'a str,
}

struct Change {
    record: FileChange,
    before: Option<String>,
    after: Option<String>,
}

impl MutationContext<'_> {
    pub(super) fn apply(
        &self,
        transaction: ManagedWrite<'_>,
        edits: Vec<MutationEdit>,
    ) -> Result<MutationReceipt, ApiError> {
        self.apply_with_checkpoint(transaction, edits, |_| Ok(()))
    }

    fn apply_with_checkpoint(
        &self,
        transaction: ManagedWrite<'_>,
        mut edits: Vec<MutationEdit>,
        mut checkpoint: impl FnMut(Checkpoint) -> Result<(), ApiError>,
    ) -> Result<MutationReceipt, ApiError> {
        check_storage_recovery(self.state)?;
        let operation = uuid::Uuid::parse_str(self.operation)
            .ok()
            .filter(|id| id.to_string() == self.operation)
            .ok_or_else(|| ApiError::invalid("Expected a canonical operation UUID"))?;
        edits.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        validate_edits(&edits)?;
        let fingerprint = sha256_hex(&serde_json::to_vec(&edits).map_err(ApiError::internal)?);
        let root = Path::new(&self.state.space_folder_path)
            .canonicalize()
            .map_err(ApiError::internal)?;
        let space = self.state.space.as_ref();
        if let Some(existing) = Journal::get(self.metadata, self.operation)? {
            if existing.workspace != self.workspace
                || existing.account != self.account
                || existing.fingerprint != fingerprint
                || existing.manifest.root != root
            {
                return Err(operation_id_reused());
            }
            match existing.status.as_str() {
                "committed" => return Ok(existing.receipt()),
                "conflict" => return Err(recovery_conflict()),
                _ => {
                    if self.recover(&existing)? {
                        return Ok(existing.receipt());
                    }
                }
            }
        }
        let changes = plan_edits(&root, space, edits)?;
        let files: Vec<_> = changes
            .iter()
            .map(|change| OperationFile {
                path: &change.record.path,
                before: change.before.as_deref().map(str::as_bytes),
                after: change.after.as_deref().map(str::as_bytes),
            })
            .collect();
        let commit = transaction
            .plan_operation(self.operation, self.actor, &files)
            .map_err(ApiError::internal)?;
        let mut journal = Journal {
            id: operation.to_string(),
            workspace: self.workspace.to_owned(),
            account: self.account.to_owned(),
            fingerprint,
            status: "pending".into(),
            attempted: 0,
            manifest: Manifest {
                git: commit.publication(),
                root,
                changes: changes.iter().map(|change| change.record.clone()).collect(),
            },
        };
        let materials = self.metadata.operation_directory(self.operation);
        journal.begin(self.metadata)?;
        if let Err(error) = save_materials(&materials, &changes) {
            journal.finish(self.metadata, None)?;
            return Err(error);
        }
        let publish = (|| {
            let prepared = commit.prepare().map_err(ApiError::internal)?;
            for (index, change) in changes.iter().enumerate() {
                checkpoint(Checkpoint::BeforeWrite(index))?;
                let current = current_markdown(&journal.manifest.root, space, &change.record.path)?;
                let revision = digest(current.as_ref());
                if revision != change.record.before_revision {
                    return Err(ApiError::conflict(revision));
                }
                journal.attempt(self.metadata, index + 1)?;
                let file = write_snapshot(
                    space,
                    &change.record.path,
                    change.after.as_deref().map(str::as_bytes),
                )?;
                self.record_change(&change.record.path, change.record.revision.as_deref(), file);
            }
            checkpoint(Checkpoint::BeforePublish)?;
            for change in &changes {
                let current = current_markdown(&journal.manifest.root, space, &change.record.path)?;
                let revision = digest(current.as_ref());
                if revision != change.record.revision {
                    return Err(ApiError::conflict(revision));
                }
            }
            prepared
                .publish_operation(&journal.manifest.git, || {
                    let _ = checkpoint(Checkpoint::AfterPublish);
                })
                .map_err(ApiError::internal)
        })();
        match publish {
            Ok(index_installed) => {
                transaction
                    .finish_operation(changes.iter().map(|change| change.record.path.as_str()));
                if let Some(engine) = &self.state.revisions {
                    engine.notify_file_saved();
                }
                if index_installed {
                    journal.finish(self.metadata, Some("committed"))?;
                }
                Ok(journal.receipt())
            }
            Err(error) => {
                if self.recover(&journal)? {
                    transaction
                        .finish_operation(changes.iter().map(|change| change.record.path.as_str()));
                    Ok(journal.receipt())
                } else {
                    Err(error)
                }
            }
        }
    }

    fn recover(&self, journal: &Journal) -> Result<bool, ApiError> {
        let result = recover_pending(self.metadata, self.state.space.as_ref(), journal, false);
        if let Err(error) = &result {
            if error.code() != "needs_repair" {
                self.state.fs_guard.require_storage_recovery();
            }
        }
        for change in journal.manifest.changes.iter().take(journal.attempted) {
            self.state.fs_guard.forget(&change.path);
        }
        result
    }

    fn record_change(&self, path: &str, revision: Option<&str>, file: Option<FileMeta>) {
        if let (Some(revision), Some(file)) = (revision, file) {
            note_file_write(self.state, path, revision, self.actor.clone(), &file);
        } else {
            self.state.fs_guard.forget(path);
        }
    }
}

fn valid_path(path: &str) -> bool {
    !path
        .split('/')
        .any(|part| part.eq_ignore_ascii_case(super::db::PRODUCT_DIR))
        && if let Some(stem) = path.strip_suffix(".outline.md") {
            !stem.is_empty() && !stem.ends_with('/') && is_document_path(&format!("{stem}.md"))
        } else {
            is_document_path(path)
        }
}

fn validate_edits(edits: &[MutationEdit]) -> Result<(), ApiError> {
    if edits.is_empty() || edits.len() > MAX_FILES {
        return Err(ApiError::invalid("Expected between 1 and 64 file changes"));
    }
    for edit in edits {
        if !valid_path(&edit.path) {
            return Err(ApiError::invalid(
                "Expected a relative Markdown or outline path",
            ));
        }
        if edit
            .markdown
            .as_ref()
            .is_some_and(|body| body.len() > MARKDOWN_LIMIT)
        {
            return Err(too_large());
        }
    }
    if edits.windows(2).any(|pair| pair[0].path == pair[1].path) {
        return Err(ApiError::invalid(
            "A file may appear only once in an operation",
        ));
    }
    if edits
        .iter()
        .map(|edit| edit.markdown.as_ref().map_or(0, String::len))
        .sum::<usize>()
        > MAX_BATCH_BYTES
    {
        return Err(too_large());
    }
    Ok(())
}

fn plan_edits(
    root: &Path,
    space: &dyn SpacePrimitives,
    edits: Vec<MutationEdit>,
) -> Result<Vec<Change>, ApiError> {
    let mut changes = Vec::new();
    let mut old_bytes = 0;
    for edit in edits {
        let before = current_markdown(root, space, &edit.path)?;
        let before_revision = digest(before.as_ref());
        if before_revision != edit.base_revision {
            return Err(ApiError::conflict(before_revision));
        }
        if before == edit.markdown {
            continue;
        }
        old_bytes += before.as_ref().map_or(0, String::len);
        if old_bytes > MAX_BATCH_BYTES {
            return Err(too_large());
        }
        changes.push(Change {
            record: FileChange {
                path: edit.path,
                before_revision,
                revision: digest(edit.markdown.as_ref()),
            },
            before,
            after: edit.markdown,
        });
    }
    if changes.is_empty() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "no_changes",
            "Operation matches the current files",
        ));
    }
    Ok(changes)
}

fn digest(markdown: Option<&String>) -> Option<String> {
    markdown.map(|body| sha256_hex(body.as_bytes()))
}

fn current_markdown(
    root: &Path,
    space: &dyn SpacePrimitives,
    path: &str,
) -> Result<Option<String>, ApiError> {
    check_native_path(root, path)?;
    match space.get_file_meta(path) {
        Err(SpaceError::NotFound) => return Ok(None),
        Ok(meta) if meta.size > MARKDOWN_LIMIT as i64 => return Err(too_large()),
        Err(error) => return Err(error.into()),
        _ => {}
    }
    let (bytes, _) = space.read_file(path)?;
    if bytes.len() > MARKDOWN_LIMIT {
        return Err(too_large());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| ApiError::invalid("Markdown file is not UTF-8"))
}

fn write_snapshot(
    space: &dyn SpacePrimitives,
    path: &str,
    bytes: Option<&[u8]>,
) -> Result<Option<FileMeta>, ApiError> {
    match bytes {
        Some(contents) => Ok(Some(space.write_file(path, contents, None)?)),
        None => {
            space.delete_file(path)?;
            Ok(None)
        }
    }
}

fn save_materials(path: &Path, changes: &[Change]) -> Result<(), ApiError> {
    let parent = path.parent().expect("recovery parent");
    fs::create_dir_all(parent).map_err(ApiError::internal)?;
    remove_materials(path).map_err(ApiError::internal)?;
    fs::create_dir(path).map_err(ApiError::internal)?;
    for (number, change) in changes.iter().enumerate() {
        if let Some(bytes) = &change.before {
            File::create(path.join(number.to_string()))
                .and_then(|mut file| {
                    file.write_all(bytes.as_bytes())
                        .and_then(|()| file.sync_all())
                })
                .map_err(ApiError::internal)?;
        }
    }
    #[cfg(unix)]
    for directory in [path, parent, parent.parent().expect("metadata parent")] {
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(ApiError::internal)?;
    }
    Ok(())
}

fn remove_materials(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn recovery_conflict() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "needs_repair",
        "An outside change was preserved. The interrupted operation needs review.",
    )
}

fn operation_id_reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "operation_id_reused",
        "Operation ID is already in use",
    )
}

fn recover_pending(
    metadata: &Metadata,
    space: &dyn SpacePrimitives,
    journal: &Journal,
    after_restart: bool,
) -> Result<bool, ApiError> {
    let root = &journal.manifest.root;
    let committed = journal
        .manifest
        .git
        .recover_index(root, after_restart)
        .map_err(ApiError::internal)?;
    if committed {
        journal.finish(metadata, Some("committed"))?;
        return Ok(true);
    }
    let materials = metadata.operation_directory(&journal.id);
    let mut conflict = false;
    for (index, change) in journal
        .manifest
        .changes
        .iter()
        .take(journal.attempted)
        .enumerate()
        .rev()
    {
        let path = &change.path;
        if !valid_path(path) {
            return Err(ApiError::internal("Invalid path in mutation journal"));
        }
        // A foreign process may have replaced a file with a directory or symlink.
        match fs::symlink_metadata(root.join(path)) {
            Ok(meta) if !meta.is_file() => {
                conflict = true;
                continue;
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(ApiError::internal(error)),
        }
        let current = match current_markdown(root, space, path) {
            Ok(markdown) => digest(markdown.as_ref()),
            Err(error) if error.is_file_conflict() => {
                conflict = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        if current == change.before_revision {
            continue;
        }
        if current != change.revision {
            conflict = true;
            continue;
        }
        let before = if let Some(expected) = &change.before_revision {
            let bytes = fs::read(materials.join(index.to_string())).map_err(ApiError::internal)?;
            if sha256_hex(&bytes) != *expected {
                return Err(ApiError::internal(
                    "Mutation recovery bytes failed verification",
                ));
            }
            Some(bytes)
        } else {
            None
        };
        write_snapshot(space, path, before.as_deref())?;
    }
    journal.finish(metadata, conflict.then_some("conflict"))?;
    if conflict {
        return Err(recovery_conflict());
    }
    Ok(false)
}

pub(super) fn recover_startup(root: &Path, metadata: &Metadata) -> Result<(), String> {
    let pending = || -> Result<Vec<Journal>, ApiError> {
        let connection = metadata.connection()?;
        let mut query = connection.prepare("SELECT * FROM mutations WHERE state = 'pending'")?;
        let rows = query
            .query_map([], Journal::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    };
    let pending = pending().map_err(|error| format!("{error:?}"))?;
    if pending.is_empty() {
        return Ok(());
    }
    let config = MultiConfig::load(&root.join("spaces.json"))?;
    for journal in pending {
        let space_id = metadata
            .space_id(&journal.workspace)
            .map_err(|error| format!("{error:?}"))?;
        let space = config
            .spaces
            .get(&space_id)
            .ok_or_else(|| format!("Missing workspace for interrupted operation {}", journal.id))?;
        let folder = resolve_folder(root, &space_id, &space.folder)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if folder != journal.manifest.root
            || discover_repo_root(&folder).as_deref() != Some(folder.as_path())
        {
            return Err(format!(
                "Workspace repository changed during operation {}",
                journal.id
            ));
        }
        let disk = DiskSpacePrimitives::new(&folder, &space.space_ignore)
            .map_err(|error| error.to_string())?;
        if let Err(error) = recover_pending(metadata, &disk, &journal, true) {
            if error.code() == "needs_repair" {
                tracing::warn!(operation = %journal.id, "Outside edits preserved during Librarian recovery");
            } else {
                return Err(format!(
                    "Could not recover Librarian operation {}: {error:?}",
                    journal.id
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
fn apply_with_checkpoint(
    service: &super::documents::DocumentService,
    account: &super::auth::Account,
    workspace: &str,
    operation: &str,
    edits: Vec<MutationEdit>,
    checkpoint: impl FnMut(Checkpoint) -> Result<(), ApiError>,
) -> Result<MutationReceipt, ApiError> {
    let (instance, actor) = service.scope(account, workspace, true)?;
    let state = super::documents::state(&instance)?;
    let engine = state.revisions.as_ref().expect("revision engine");
    let context = MutationContext {
        metadata: &service.metadata,
        state,
        actor: &actor,
        workspace,
        account: account.username(),
        operation,
    };
    engine.with_managed_write(|managed| context.apply_with_checkpoint(managed, edits, checkpoint))
}

#[cfg(test)]
mod tests;
