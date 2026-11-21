use std::{fs, io::ErrorKind, path::Path};

use axum::http::StatusCode;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::{revision::sha256_hex, space::GitignoreMatcher};
use uuid::Uuid;

use super::{changed, path_exists, validate_path, Action, ActionResult, Input, Kind};
use crate::{
    auth::Actor,
    product::{
        ai::managed_engine,
        contract::ApiError,
        db::Metadata,
        documents::{
            check_file_path, check_storage_recovery, is_document_path, outline_path, product_read,
            state, too_large, DocumentService,
        },
        mutations::{self, FileEdit, MutationContext},
        snapshots::git_blobs,
    },
    revisions::engine::ManagedWrite,
    state::ServerState,
};

pub(super) struct Endpoint<'a> {
    pub state: &'a ServerState,
    pub workspace: &'a str,
    pub actor: &'a Actor,
    pub ignore: &'a GitignoreMatcher,
}

impl Endpoint<'_> {
    fn root(&self) -> &Path {
        Path::new(&self.state.space_folder_path)
    }

    fn attr(&self, path: &str) -> Result<Option<fs::Metadata>, ApiError> {
        check_file_path(self.state, path)?;
        match fs::symlink_metadata(self.root().join(path)) {
            Ok(m) => Ok(Some(m)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) if e.kind() == ErrorKind::NotADirectory => Err(path_exists()),
            Err(e) => Err(ApiError::internal(e)),
        }
    }

    fn bytes(&self, path: &str) -> Result<Vec<u8>, ApiError> {
        mutations::current_bytes(self.root(), self.state.space.as_ref(), path)?.ok_or_else(changed)
    }

    fn vacant(&self, path: &str, kind: Kind) -> Result<(), ApiError> {
        validate_path(self.state, self.ignore, path, kind == Kind::Folder)?;
        if self.attr(path)?.is_some() {
            return Err(path_exists());
        }
        if kind == Kind::Document {
            if !is_document_path(path) {
                return Err(ApiError::invalid("Expected a Markdown document path"));
            }
            let sidecar = outline_path(path);
            validate_path(self.state, self.ignore, &sidecar, false)?;
            if self.attr(&sidecar)?.is_some() {
                return Err(path_exists());
            }
        }
        if let Some((parent, _)) = path.rsplit_once('/') {
            if !self.attr(parent)?.is_some_and(|attr| attr.is_dir()) {
                return Err(changed());
            }
        }
        Ok(())
    }
}

// Besides revision hashes and document IDs, bind the preview to actual filesystem
// objects (including an empty directory removed and recreated at the same name).
#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Identity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    inode: u64,
    birth: Option<std::time::SystemTime>,
}

impl From<&fs::Metadata> for Identity {
    fn from(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            #[cfg(unix)]
            dev: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            birth: metadata.created().ok(),
        }
    }
}

pub(super) fn folder_id(
    key: &str,
    workspace: &str,
    path: &str,
    metadata: &fs::Metadata,
) -> Result<String, ApiError> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let binding = serde_json::to_vec(&(workspace, path, Identity::from(metadata)))
        .map_err(ApiError::internal)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("valid HMAC key");
    mac.update(&binding);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Item {
    path: String,
    object: Identity,
    revision: Option<String>,
    document: Option<String>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Inventory {
    items: Vec<Item>,
    target_parent: Option<Identity>,
}

impl Inventory {
    pub(super) fn file_count(&self) -> usize {
        self.files().count()
    }
    fn files(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|item| item.revision.is_some())
    }
    fn dirs(&self) -> impl DoubleEndedIterator<Item = &Item> {
        self.items.iter().filter(|item| item.revision.is_none())
    }
}

fn source_tree(
    metadata: &Metadata,
    source: &Endpoint<'_>,
    input: &Input,
    folder_key: Option<&str>,
) -> Result<Inventory, ApiError> {
    let root = &input.source_path;
    let folder = input.source_kind == Kind::Folder;
    validate_path(source.state, source.ignore, root, folder)?;
    if !folder && !is_document_path(root) {
        return Err(ApiError::invalid("Expected a Markdown document path"));
    }
    let attr = source.attr(root)?.ok_or_else(|| {
        if input.expected_document_id.is_some() || input.expected_folder_id.is_some() {
            changed()
        } else {
            ApiError::not_found()
        }
    })?;
    if attr.is_dir() != folder {
        return Err(changed());
    }
    if let (Some(expected), Some(key)) = (&input.expected_folder_id, folder_key) {
        if folder_id(key, source.workspace, root, &attr)? != *expected {
            return Err(changed());
        }
    }
    let mut todo = vec![(root.clone(), attr)];
    if !folder {
        let path = outline_path(root);
        if let Some(attr) = source.attr(&path)? {
            if !attr.is_file() {
                return Err(changed());
            }
            todo.push((path, attr));
        }
    }
    let mut items = Vec::new();
    let mut file_count = 0;
    let mut total = 0;
    while let Some((path, attr)) = todo.pop() {
        validate_path(source.state, source.ignore, &path, attr.is_dir())?;
        let object = Identity::from(&attr);
        let (revision, document) = if attr.is_dir() {
            for entry in fs::read_dir(source.root().join(&path)).map_err(ApiError::internal)? {
                let entry = entry.map_err(ApiError::internal)?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| ApiError::invalid("Expected UTF-8 file names"))?;
                let child = format!("{path}/{name}");
                let stat = fs::symlink_metadata(entry.path()).map_err(ApiError::internal)?;
                if !stat.is_file() && !stat.is_dir() {
                    return Err(ApiError::invalid(
                        "Directory contains a link or special file",
                    ));
                }
                todo.push((child, stat));
                if items.len() + todo.len() > 4096 {
                    return Err(too_large());
                }
            }
            (None, None)
        } else if attr.is_file() {
            file_count += 1;
            if file_count > mutations::MAX_FILES {
                return Err(too_large());
            }
            let bytes = source.bytes(&path)?;
            total += bytes.len();
            if total > mutations::MAX_BATCH_BYTES {
                return Err(too_large());
            }
            let document = is_document_path(&path)
                .then(|| metadata.document_id(source.workspace, &path))
                .transpose()?;
            if path == *root
                && input.expected_document_id.is_some()
                && document != input.expected_document_id
            {
                return Err(changed());
            }
            (Some(sha256_hex(&bytes)), document)
        } else {
            return Err(ApiError::invalid("Expected a regular file or directory"));
        };
        items.push(Item {
            path,
            object,
            revision,
            document,
        });
    }
    items.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(Inventory {
        items,
        target_parent: None,
    })
}

fn destination(input: &Input, path: &str) -> String {
    let Some(target) = &input.target_path else {
        return path.to_owned();
    };
    if let Some(tail) = path.strip_prefix(&input.source_path) {
        format!("{target}{tail}")
    } else {
        outline_path(target)
    }
}

pub(super) fn inspect(
    metadata: &Metadata,
    source: &Endpoint<'_>,
    target: Option<&Endpoint<'_>>,
    input: &Input,
    folder_key: &str,
) -> Result<Inventory, ApiError> {
    let mut inventory = source_tree(metadata, source, input, Some(folder_key))?;
    if let Some(target) = target {
        let dst = input
            .target_path
            .as_deref()
            .ok_or_else(|| ApiError::invalid("Missing destination"))?;
        let src = &input.source_path;
        if source.workspace == target.workspace {
            if src == dst
                || dst.starts_with(&format!("{src}/"))
                || src.starts_with(&format!("{dst}/"))
            {
                return Err(ApiError::invalid("Source and destination must not overlap"));
            }
            if input.action == Action::Move && inventory.file_count() > mutations::MAX_FILES / 2 {
                return Err(too_large());
            }
        } else {
            let source_root = source.root().canonicalize().map_err(ApiError::internal)?;
            let target_root = target.root().canonicalize().map_err(ApiError::internal)?;
            if source_root.starts_with(&target_root) || target_root.starts_with(&source_root) {
                return Err(ApiError::invalid("Source and destination share storage"));
            }
        }
        target.vacant(dst, input.source_kind)?;
        let parent = dst.rsplit_once('/').map_or("", |(parent, _)| parent);
        let attr = target.attr(parent)?.ok_or_else(changed)?;
        inventory.target_parent = Some(Identity::from(&attr));
        let conn = metadata.connection()?;
        for item in &inventory.items {
            let path = destination(input, &item.path);
            validate_path(target.state, target.ignore, &path, item.revision.is_none())?;
            if item.document.is_some()
                && conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM documents WHERE workspace_id=? AND path=?)",
                    params![target.workspace, path],
                    |r| r.get::<_, bool>(0),
                )?
            {
                return Err(path_exists());
            }
        }
    }
    Ok(inventory)
}

pub(in crate::product) fn migrate(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_file_actions (
        operation_id TEXT PRIMARY KEY, account TEXT NOT NULL, workspace TEXT NOT NULL,
        token TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS file_action_outputs(step TEXT PRIMARY KEY, objects TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS empty_directory_steps(id TEXT PRIMARY KEY, object TEXT);
        CREATE TABLE IF NOT EXISTS restored_document_history (
            workspace TEXT NOT NULL, document TEXT NOT NULL, restore_commit TEXT NOT NULL,
            deletion_commit TEXT NOT NULL, path TEXT NOT NULL,
            UNIQUE(workspace,document,restore_commit));",
    )
}

#[derive(Serialize, Deserialize)]
struct Plan {
    input: Input,
    inventory: Inventory,
    destination_ids: Vec<String>,
    source_step: String,
    target_step: String,
    undo_step: String,
}

struct Intent {
    id: String,
    account: String,
    workspace: String,
    token: String,
    plan: Plan,
    status: String,
}

impl Intent {
    fn get(metadata: &Metadata, operation: &str) -> Result<Option<Self>, ApiError> {
        let row = metadata.connection()?.query_row(
            "SELECT account, workspace, token, plan, status FROM workspace_file_actions WHERE operation_id=?",
            [operation],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_,String>(3)?, row.get(4)?)),
        ).optional()?;
        let Some((account, workspace, token, plan, status)) = row else {
            return Ok(None);
        };
        Ok(Some(Self {
            id: operation.into(),
            account,
            workspace,
            token,
            status,
            plan: serde_json::from_str(&plan).map_err(ApiError::internal)?,
        }))
    }

    fn save(&self, metadata: &Metadata) -> Result<(), ApiError> {
        metadata.connection()?.execute("INSERT INTO workspace_file_actions(operation_id,account,workspace,token,plan,status) VALUES(?,?,?,?,?,?)",
            params![self.id,self.account,self.workspace,self.token,serde_json::to_string(&self.plan).map_err(ApiError::internal)?,self.status])?;
        Ok(())
    }

    fn result(&self, undo: bool) -> ActionResult {
        let input = &self.plan.input;
        let doc = self
            .plan
            .inventory
            .items
            .iter()
            .filter(|i| i.document.is_some())
            .zip(&self.plan.destination_ids)
            .find(|(i, _)| i.path == input.source_path)
            .map(|(_, id)| id.clone());
        ActionResult {
            operation_id: self.id.clone(),
            workspace_id: input
                .target_workspace
                .as_ref()
                .unwrap_or(&self.workspace)
                .clone(),
            path: input
                .target_path
                .as_ref()
                .unwrap_or(&input.source_path)
                .clone(),
            document_id: doc,
            undoable: input.action == Action::Delete && !undo,
        }
    }
}

/// Reconcile an AI receipt after the directory transaction was durably completed.
pub(in crate::product) fn completed(
    metadata: &Metadata,
    account: &str,
    workspace: &str,
    request: &super::Apply,
) -> Result<Option<ActionResult>, ApiError> {
    let Some(intent) = Intent::get(metadata, &request.operation_id)? else {
        return Ok(None);
    };
    if intent.account != account
        || intent.workspace != workspace
        || intent.token != request.token
        || intent.plan.input != request.input
    {
        return Err(reused());
    }
    Ok((intent.status == "done").then(|| intent.result(false)))
}

fn reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "operation_id_reused",
        "Operation ID was used for a different request",
    )
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub(super) fn apply(
    metadata: &Metadata,
    account: &str,
    source: &Endpoint<'_>,
    target: Option<&Endpoint<'_>>,
    request: &super::Apply,
    folder_key: &str,
    verify: impl FnOnce(&Inventory) -> Result<(), ApiError>,
) -> Result<ActionResult, ApiError> {
    let input = &request.input;
    let operation = request.operation_id.as_str();
    let token = request.token.as_str();
    with_locks(source, target, input.action, |st, tt| {
        let intent = if let Some(existing) = Intent::get(metadata, operation)? {
            if existing.account != account
                || existing.workspace != source.workspace
                || existing.token != token
                || existing.plan.input != *input
            {
                return Err(reused());
            }
            if existing.status == "conflict" {
                return Err(ApiError::new(StatusCode::CONFLICT,"file_action_recovery_conflict",
                    "A file changed during recovery. Later files were preserved. The original bytes remain in workspace Git history."));
            }
            if existing.status != "pending" {
                return Ok(existing.result(false));
            }
            verify(&existing.plan.inventory)?;
            existing
        } else {
            let inventory = inspect(metadata, source, target, input, folder_key).map_err(stale)?;
            verify(&inventory)?;
            let destination_ids = inventory
                .items
                .iter()
                .filter_map(|item| item.document.as_ref())
                .map(|id| {
                    if input.action == Action::Copy {
                        format!("doc_{}", Uuid::new_v4().simple())
                    } else {
                        id.clone()
                    }
                })
                .collect();
            let intent = Intent {
                id: operation.into(),
                account: account.into(),
                workspace: source.workspace.into(),
                token: token.into(),
                status: "pending".into(),
                plan: Plan {
                    input: input.clone(),
                    inventory,
                    destination_ids,
                    source_step: new_id(),
                    target_step: new_id(),
                    undo_step: new_id(),
                },
            };
            intent.save(metadata)?;
            intent
        };
        execute(metadata, &intent, source, target, st, tt, false)?;
        Ok(intent.result(false))
    })
}

// One workspace gate serializes directory commands. The revision and filesystem
// guards also exclude edits, reads and commits through every other product API.
fn with_locks<T>(
    source: &Endpoint<'_>,
    target: Option<&Endpoint<'_>>,
    action: Action,
    run: impl FnOnce(Option<ManagedWrite<'_>>, Option<ManagedWrite<'_>>) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    check_storage_recovery(source.state)?;
    if let Some(target) = target {
        check_storage_recovery(target.state)?;
    }
    let cross = target.filter(|t| t.workspace != source.workspace);
    if let Some(target) = cross {
        let target_engine = managed_engine(target.state)?;
        if action == Action::Copy {
            let _source = product_read(source.state)?;
            return target_engine.with_managed_write(|tt| run(None, Some(tt)));
        }
        managed_engine(source.state)?
            .with_managed_write(|st| target_engine.with_managed_write(|tt| run(Some(st), Some(tt))))
    } else {
        managed_engine(source.state)?.with_managed_write(|st| run(Some(st), None))
    }
}

fn require_tx(tx: Option<ManagedWrite<'_>>) -> Result<ManagedWrite<'_>, ApiError> {
    tx.ok_or_else(|| ApiError::internal("Missing managed file-action transaction"))
}

fn removal_edits(inventory: &Inventory) -> Vec<FileEdit> {
    inventory
        .files()
        .map(|i| FileEdit {
            path: i.path.clone(),
            base_revision: i.revision.clone(),
            contents: None,
        })
        .collect()
}

fn file_contents(endpoint: &Endpoint<'_>, item: &Item) -> Result<Vec<u8>, ApiError> {
    let bytes = endpoint.bytes(&item.path)?;
    if Some(sha256_hex(&bytes)) != item.revision {
        return Err(changed());
    }
    Ok(bytes)
}

fn additions(source: &Endpoint<'_>, plan: &Plan) -> Result<Vec<FileEdit>, ApiError> {
    plan.inventory
        .files()
        .map(|item| {
            Ok(FileEdit {
                path: destination(&plan.input, &item.path),
                base_revision: None,
                contents: Some(file_contents(source, item)?),
            })
        })
        .collect()
}

fn mutate(
    metadata: &Metadata,
    endpoint: &Endpoint<'_>,
    intent: &Intent,
    step: &str,
    tx: ManagedWrite<'_>,
    edits: Vec<FileEdit>,
    subject: &str,
) -> Result<(), ApiError> {
    if !edits.is_empty() {
        let outputs = edits
            .iter()
            .filter(|edit| edit.contents.is_some())
            .map(|e| e.path.clone())
            .collect::<Vec<_>>();
        MutationContext {
            metadata,
            state: endpoint.state,
            actor: endpoint.actor,
            workspace: endpoint.workspace,
            account: &intent.account,
            operation: step,
        }
        .apply_files_before_publish(tx, edits, subject, || {
            if !outputs.is_empty() {
                let objects = outputs
                    .iter()
                    .map(|path| {
                        let attr = endpoint.attr(path)?.ok_or_else(changed)?;
                        Ok::<_, ApiError>((path, Identity::from(&attr)))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                metadata.connection()?.execute(
                    "INSERT OR REPLACE INTO file_action_outputs(step,objects) VALUES(?,?)",
                    params![
                        step,
                        serde_json::to_string(&objects).map_err(ApiError::internal)?
                    ],
                )?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn create_dirs(endpoint: &Endpoint<'_>, plan: &Plan, restoring: bool) -> Result<(), ApiError> {
    for dir in plan.inventory.dirs() {
        let path = if restoring {
            dir.path.clone()
        } else {
            destination(&plan.input, &dir.path)
        };
        check_file_path(endpoint.state, &path)?;
        fs::create_dir_all(endpoint.root().join(path)).map_err(ApiError::internal)?;
    }
    Ok(())
}

fn remove_dirs(source: &Endpoint<'_>, plan: &Plan) -> Result<(), ApiError> {
    for dir in plan.inventory.dirs().rev() {
        let Some(attr) = source.attr(&dir.path)? else {
            continue;
        };
        if !attr.is_dir() || Identity::from(&attr) != dir.object {
            continue;
        }
        match fs::remove_dir(source.root().join(&dir.path)) {
            Ok(()) => {}
            Err(e) if matches!(e.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::NotFound) => {}
            Err(e) => return Err(ApiError::internal(e)),
        }
    }
    // DiskSpacePrimitives normally prunes empty ancestors after deleting a
    // file. Folder management makes the selected object's parent persistent.
    if let Some((parent, _)) = plan.input.source_path.rsplit_once('/') {
        check_file_path(source.state, parent)?;
        fs::create_dir_all(source.root().join(parent)).map_err(ApiError::internal)?;
    }
    Ok(())
}

// Stage an empty folder tree on the same filesystem. Recording its inode before
// the exclusive rename distinguishes our folder from an outside replacement
// across a crash, even when both trees contain zero files.
fn prepare_empty(
    metadata: &Metadata,
    target: &Endpoint<'_>,
    plan: &Plan,
    step: &str,
) -> Result<(), ApiError> {
    let stage = target.root().join(format!(".librarian-directory-{step}"));
    fs::create_dir(&stage).map_err(ApiError::internal)?;
    for dir in plan.inventory.dirs() {
        if dir.path == plan.input.source_path {
            continue;
        }
        let suffix = dir
            .path
            .strip_prefix(&plan.input.source_path)
            .and_then(|s| s.strip_prefix('/'))
            .ok_or_else(changed)?;
        fs::create_dir_all(stage.join(suffix)).map_err(ApiError::internal)?;
    }
    let attr = fs::symlink_metadata(&stage).map_err(ApiError::internal)?;
    let object = serde_json::to_string(&Identity::from(&attr)).map_err(ApiError::internal)?;
    metadata.connection()?.execute(
        "INSERT INTO empty_directory_steps(id,object) VALUES(?,?)",
        params![step, object],
    )?;
    Ok(())
}

fn publish_empty(
    metadata: &Metadata,
    target: &Endpoint<'_>,
    step: &str,
    path: &str,
) -> Result<(), ApiError> {
    let object: String = metadata.connection()?.query_row(
        "SELECT object FROM empty_directory_steps WHERE id=?",
        [step],
        |r| r.get(0),
    )?;
    let object: Identity = serde_json::from_str(&object).map_err(ApiError::internal)?;
    if let Some(attr) = target.attr(path)? {
        return if attr.is_dir() && Identity::from(&attr) == object {
            Ok(())
        } else {
            Err(path_exists())
        };
    }
    let stage = target.root().join(format!(".librarian-directory-{step}"));
    let attr = fs::symlink_metadata(&stage).map_err(ApiError::internal)?;
    if !attr.is_dir() || Identity::from(&attr) != object {
        return Err(changed());
    }
    crate::multi::migrate::execute::rename_no_replace(&stage, &target.root().join(path)).map_err(
        |e| {
            if e.kind() == ErrorKind::AlreadyExists {
                path_exists()
            } else {
                ApiError::internal(e)
            }
        },
    )
}

fn verify_outputs(
    metadata: &Metadata,
    endpoint: &Endpoint<'_>,
    plan: &Plan,
    step: &str,
    restoring: bool,
) -> Result<(), ApiError> {
    if plan.inventory.file_count() == 0 {
        return Ok(());
    }
    let saved: String = metadata.connection()?.query_row(
        "SELECT objects FROM file_action_outputs WHERE step=?",
        [step],
        |r| r.get(0),
    )?;
    let objects: std::collections::BTreeMap<String, Identity> =
        serde_json::from_str::<Vec<(String, Identity)>>(&saved)
            .map_err(ApiError::internal)?
            .into_iter()
            .collect();
    for item in plan.inventory.files() {
        let path = if restoring {
            item.path.clone()
        } else {
            destination(&plan.input, &item.path)
        };
        let attr = endpoint.attr(&path)?.ok_or_else(changed)?;
        if !attr.is_file()
            || objects.get(&path) != Some(&Identity::from(&attr))
            || Some(sha256_hex(&endpoint.bytes(&path)?)) != item.revision
        {
            return Err(changed());
        }
    }
    Ok(())
}

fn finish(metadata: &Metadata, intent: &Intent, undo: bool) -> Result<(), ApiError> {
    let plan = &intent.plan;
    let history = if undo && !plan.destination_ids.is_empty() {
        let receipt = |step: &str| {
            mutations::receipt(metadata, step, &intent.workspace, &intent.account)?
                .ok_or_else(changed)
        };
        Some((
            receipt(&plan.undo_step)?.commit_id,
            receipt(&plan.source_step)?.commit_id,
        ))
    } else {
        None
    };
    let mut conn = metadata.connection()?;
    let tx = conn.transaction()?;
    for (item, id) in plan
        .inventory
        .items
        .iter()
        .filter(|i| i.document.is_some())
        .zip(&plan.destination_ids)
    {
        let target = plan
            .input
            .target_workspace
            .as_deref()
            .unwrap_or(&intent.workspace);
        let dest = destination(&plan.input, &item.path);
        let affected = match (plan.input.action, undo) {
            (Action::Delete, false) => tx.execute(
                "DELETE FROM documents WHERE id=? AND workspace_id=? AND path=?",
                params![id, intent.workspace, item.path],
            )?,
            (Action::Move, false) => tx.execute(
                "UPDATE documents SET workspace_id=?, path=? WHERE id=? AND workspace_id=? AND path=?",
                params![target, dest, id, intent.workspace, item.path],
            )?,
            _ => tx.execute(
                "INSERT INTO documents (id, workspace_id, path) VALUES (?, ?, ?)",
                params![id, target, dest],
            )?,
        };
        if affected != 1 {
            return Err(changed());
        }
        if let Some((restored, deleted)) = &history {
            tx.execute("INSERT INTO restored_document_history(workspace, document, restore_commit, deletion_commit, path)
                        VALUES(?, ?, ?, ?, ?)",params![intent.workspace,id,restored,deleted,item.path])?;
        }
    }
    tx.execute(
        "UPDATE workspace_file_actions SET status=? WHERE operation_id=?",
        params![if undo { "undone" } else { "done" }, intent.id],
    )?;
    tx.commit()?;
    Ok(())
}

fn completed_step(
    metadata: &Metadata,
    workspace: &str,
    intent: &Intent,
    id: &str,
) -> Result<bool, ApiError> {
    if intent.plan.inventory.file_count() == 0 {
        return Ok(metadata.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM empty_directory_steps WHERE id=?)",
            [id],
            |r| r.get(0),
        )?);
    }
    Ok(mutations::receipt(metadata, id, workspace, &intent.account)?.is_some())
}

fn run_step(
    metadata: &Metadata,
    endpoint: &Endpoint<'_>,
    intent: &Intent,
    step: &str,
    tx: ManagedWrite<'_>,
    edits: Vec<FileEdit>,
    subject: &str,
) -> Result<(), ApiError> {
    if edits.is_empty() {
        metadata
            .connection()?
            .execute("INSERT INTO empty_directory_steps(id) VALUES(?)", [step])?;
        Ok(())
    } else {
        mutate(metadata, endpoint, intent, step, tx, edits, subject)
    }
}

fn set_status(metadata: &Metadata, intent: &Intent, status: &str) -> Result<(), ApiError> {
    metadata.connection()?.execute(
        "UPDATE workspace_file_actions SET status=? WHERE operation_id=?",
        params![status, intent.id],
    )?;
    Ok(())
}

fn verify_source(metadata: &Metadata, source: &Endpoint<'_>, plan: &Plan) -> Result<(), ApiError> {
    let current = source_tree(metadata, source, &plan.input, None).map_err(stale)?;
    if current.items != plan.inventory.items {
        return Err(changed());
    }
    Ok(())
}

fn stale(err: ApiError) -> ApiError {
    if err.is_file_conflict() || err.code() == "path_exists" {
        changed()
    } else {
        err
    }
}

fn execute(
    metadata: &Metadata,
    intent: &Intent,
    source: &Endpoint<'_>,
    target: Option<&Endpoint<'_>>,
    source_tx: Option<ManagedWrite<'_>>,
    target_tx: Option<ManagedWrite<'_>>,
    recovering: bool,
) -> Result<(), ApiError> {
    let plan = &intent.plan;
    let action = plan.input.action;
    let mut published = false;
    let result = (|| {
        if let Some(target) = target {
            let dst = plan.input.target_path.as_deref().ok_or_else(changed)?;
            let parent = dst.rsplit_once('/').map_or("", |(parent, _)| parent);
            let parent_attr = target.attr(parent)?.ok_or_else(changed)?;
            if plan.inventory.target_parent != Some(Identity::from(&parent_attr)) {
                return Err(changed());
            }
            let combined = source.workspace == target.workspace && action == Action::Move;
            let target_done =
                completed_step(metadata, target.workspace, intent, &plan.target_step)?;
            published = target_done;
            if !target_done {
                target.vacant(dst, plan.input.source_kind).map_err(stale)?;
                verify_source(metadata, source, plan)?;
                let mut edits = additions(source, plan)?;
                if combined {
                    edits.extend(removal_edits(&plan.inventory));
                }
                if plan.inventory.file_count() == 0 {
                    prepare_empty(metadata, target, plan, &plan.target_step)?;
                } else {
                    run_step(
                        metadata,
                        target,
                        intent,
                        &plan.target_step,
                        require_tx(target_tx.or(source_tx))?,
                        edits,
                        if action == Action::Move {
                            "Move workspace files"
                        } else {
                            "Copy workspace files"
                        },
                    )?;
                }

                published = true;
            }
            if plan.inventory.file_count() == 0 {
                publish_empty(metadata, target, &plan.target_step, dst)?;
            } else {
                verify_outputs(metadata, target, plan, &plan.target_step, false)?;
                create_dirs(target, plan, false)?;
            }
            if action == Action::Move
                && !combined
                && !completed_step(metadata, source.workspace, intent, &plan.source_step)?
            {
                verify_source(metadata, source, plan)?;
                run_step(
                    metadata,
                    source,
                    intent,
                    &plan.source_step,
                    require_tx(source_tx)?,
                    removal_edits(&plan.inventory),
                    "Move files to another workspace",
                )?;
            }
            if action == Action::Move {
                remove_dirs(source, plan)?;
                verify_outputs(metadata, target, plan, &plan.target_step, false)?;
            }
        } else {
            let done = completed_step(metadata, source.workspace, intent, &plan.source_step)?;
            if !done {
                verify_source(metadata, source, plan)?;
                run_step(
                    metadata,
                    source,
                    intent,
                    &plan.source_step,
                    require_tx(source_tx)?,
                    removal_edits(&plan.inventory),
                    "Delete workspace files",
                )?;
            }
            published = true;
            remove_dirs(source, plan)?;
        }
        finish(metadata, intent, false)
    })();
    if result.is_err() && published && !recovering {
        source.state.fs_guard.require_storage_recovery();
        if let Some(target) = target {
            target.state.fs_guard.require_storage_recovery();
        }
    }
    result
}

pub(super) fn undo(
    metadata: &Metadata,
    account: &str,
    source: &Endpoint<'_>,
    operation: &str,
) -> Result<ActionResult, ApiError> {
    let intent = Intent::get(metadata, operation)?
        .filter(|i| {
            i.account == account
                && i.workspace == source.workspace
                && i.plan.input.action == Action::Delete
        })
        .ok_or_else(ApiError::not_found)?;
    managed_engine(source.state)?.with_managed_write(|tx| {
        check_storage_recovery(source.state)?;
        if intent.status == "undone" {
            return Ok(intent.result(true));
        }
        if !matches!(intent.status.as_str(), "done" | "undoing") {
            return Err(changed());
        }
        restore(metadata, source, &intent, tx, false)?;
        Ok(intent.result(true))
    })
}

fn original_edits(
    metadata: &Metadata,
    source: &Endpoint<'_>,
    intent: &Intent,
    removal_step: &str,
) -> Result<Vec<FileEdit>, ApiError> {
    let plan = &intent.plan;
    let mut edits = Vec::new();
    if plan.inventory.file_count() > 0 {
        let deletion =
            mutations::receipt(metadata, removal_step, source.workspace, &intent.account)?
                .ok_or_else(changed)?;
        let (store, repo) = git_blobs::repo(source.state)?;
        let before = git_blobs::resolve_commit(&repo, &format!("{}^", deletion.commit_id))?;
        for item in plan.inventory.files() {
            validate_path(source.state, source.ignore, &item.path, false)?;
            let blob = git_blobs::find(
                store,
                &repo,
                &before,
                &item.path,
                mutations::max_file_bytes(&item.path),
            )?
            .ok_or_else(changed)?;
            let bytes = git_blobs::read(&repo, &blob)?;
            if Some(sha256_hex(&bytes)) != item.revision {
                return Err(changed());
            }
            edits.push(FileEdit {
                path: item.path.clone(),
                base_revision: None,
                contents: Some(bytes),
            });
        }
    }
    Ok(edits)
}

fn restore(
    metadata: &Metadata,
    source: &Endpoint<'_>,
    intent: &Intent,
    tx: ManagedWrite<'_>,
    recovering: bool,
) -> Result<(), ApiError> {
    let plan = &intent.plan;
    let done = completed_step(metadata, source.workspace, intent, &plan.undo_step)?;
    if !done {
        source.vacant(&plan.input.source_path, plan.input.source_kind)?;
        {
            let connection = metadata.connection()?;
            for item in &plan.inventory.items {
                validate_path(
                    source.state,
                    source.ignore,
                    &item.path,
                    item.revision.is_none(),
                )?;
                if let Some(id) = &item.document {
                    let occupied:bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM documents WHERE id=? OR (workspace_id=? AND path=?))",
                        params![id,source.workspace,item.path], |row| row.get(0))?;
                    if occupied {
                        return Err(path_exists());
                    }
                }
            }
        }
        let edits = original_edits(metadata, source, intent, &plan.source_step)?;
        set_status(metadata, intent, "undoing")?;
        if edits.is_empty() {
            prepare_empty(metadata, source, plan, &plan.undo_step)?;
        } else {
            run_step(
                metadata,
                source,
                intent,
                &plan.undo_step,
                tx,
                edits,
                "Restore deleted workspace files",
            )?;
        }
    }
    let result = if plan.inventory.file_count() == 0 {
        publish_empty(metadata, source, &plan.undo_step, &plan.input.source_path)
    } else {
        verify_outputs(metadata, source, plan, &plan.undo_step, true)
            .and_then(|_| create_dirs(source, plan, true))
    }
    .and_then(|_| finish(metadata, intent, true));
    if result.is_err() && !recovering {
        source.state.fs_guard.require_storage_recovery();
    }
    result
}

// If the filesystem/Git move already removed the source and a different file
// replaced a destination before metadata publication, the old ID still belongs
// to the source. Recreate its original bytes only at a vacant source path.
fn recover_move_conflict(
    metadata: &Metadata,
    source: &Endpoint<'_>,
    intent: &Intent,
) -> Result<(), ApiError> {
    let plan = &intent.plan;
    if plan.input.action != Action::Move {
        return Ok(());
    }
    let same = plan.input.target_workspace.as_deref() == Some(source.workspace);
    let removal_step = if same {
        &plan.target_step
    } else {
        &plan.source_step
    };
    if !completed_step(metadata, source.workspace, intent, removal_step)? {
        return Ok(());
    }
    if !completed_step(metadata, source.workspace, intent, &plan.undo_step)? {
        let vacant = source.vacant(&plan.input.source_path, plan.input.source_kind);
        if vacant
            .as_ref()
            .is_err_and(|e| e.code() == "path_exists" || e.is_file_conflict())
        {
            let mut db = metadata.connection()?;
            let tx = db.transaction()?;
            for item in &plan.inventory.items {
                if let Some(id) = &item.document {
                    tx.execute(
                        "DELETE FROM documents WHERE id=? AND workspace_id=? AND path=?",
                        params![id, source.workspace, item.path],
                    )?;
                }
            }
            tx.commit()?;
            return Ok(());
        }
        vacant?;
        let edits = original_edits(metadata, source, intent, removal_step)?;
        if edits.is_empty() {
            prepare_empty(metadata, source, plan, &plan.undo_step)?;
        } else {
            managed_engine(source.state)?.with_managed_write(|tx| {
                run_step(
                    metadata,
                    source,
                    intent,
                    &plan.undo_step,
                    tx,
                    edits,
                    "Recover original files after a conflicting move",
                )
            })?;
        }
    }
    if plan.inventory.file_count() == 0 {
        return publish_empty(metadata, source, &plan.undo_step, &plan.input.source_path);
    }
    verify_outputs(metadata, source, plan, &plan.undo_step, true)?;
    create_dirs(source, plan, true)?;
    let receipt = |step: &str| {
        mutations::receipt(metadata, step, source.workspace, &intent.account)?.ok_or_else(changed)
    };
    let removal = receipt(removal_step)?;
    let restoration = receipt(&plan.undo_step)?;
    let mut conn = metadata.connection()?;
    let tx = conn.transaction()?;
    for item in &plan.inventory.items {
        if let Some(id) = &item.document {
            tx.execute("INSERT OR IGNORE INTO restored_document_history(workspace, document, restore_commit, deletion_commit, path)
                VALUES(?, ?, ?, ?, ?)", params![source.workspace,id,restoration.commit_id,removal.commit_id,item.path])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn reset_conflicted_undo(metadata: &Metadata, intent: &mut Intent) -> Result<(), ApiError> {
    intent.plan.undo_step = new_id();
    let plan = serde_json::to_string(&intent.plan).map_err(ApiError::internal)?;
    metadata.connection()?.execute(
        "UPDATE workspace_file_actions SET status='done',plan=? WHERE operation_id=?",
        params![plan, intent.id],
    )?;
    Ok(())
}

fn pending_ids(metadata: &Metadata, workspace: Option<&str>) -> Result<Vec<String>, ApiError> {
    let conn = metadata.connection()?;
    let mut statement = conn.prepare(
        "SELECT operation_id FROM workspace_file_actions WHERE status IN ('pending','undoing')
         AND (?1 IS NULL OR workspace = ?1 OR json_extract(plan, '$.input.targetWorkspace') = ?1)",
    )?;
    let ids = statement
        .query_map([workspace], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

// A request can fail before the first durable write. Such a request must be
// reauthorized by the caller, and never needs the old space directory to boot.
fn needs_files(metadata: &Metadata, intent: &Intent) -> Result<bool, ApiError> {
    let plan = &intent.plan;
    if intent.status == "undoing" {
        if completed_step(metadata, &intent.workspace, intent, &plan.undo_step)? {
            return Ok(true);
        }
        set_status(metadata, intent, "done")?;
    } else {
        let target = plan
            .input
            .target_workspace
            .as_deref()
            .unwrap_or(&intent.workspace);
        if completed_step(metadata, &intent.workspace, intent, &plan.source_step)?
            || completed_step(metadata, target, intent, &plan.target_step)?
        {
            return Ok(true);
        }
        metadata.connection()?.execute(
            "DELETE FROM workspace_file_actions WHERE operation_id=?",
            [&intent.id],
        )?;
    }
    Ok(false)
}

pub(in crate::product) fn pending_retirement(
    metadata: &Metadata,
    workspace: &str,
) -> Result<bool, ApiError> {
    for id in pending_ids(metadata, Some(workspace))? {
        let intent = Intent::get(metadata, &id)?.ok_or_else(changed)?;
        if needs_files(metadata, &intent)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(in crate::product) fn recover(service: &DocumentService) -> Result<(), ApiError> {
    for id in pending_ids(&service.metadata, None)? {
        let mut intent = Intent::get(&service.metadata, &id)?.ok_or_else(changed)?;
        if !needs_files(&service.metadata, &intent)? {
            continue;
        }
        let instance = |workspace: &str| -> Result<_, ApiError> {
            let space = service.metadata.space_id(workspace)?;
            Ok(service.spaces.manager.instance(&space))
        };
        let source = instance(&intent.workspace)?;
        let target = intent
            .plan
            .input
            .target_workspace
            .as_deref()
            .map(instance)
            .transpose()?
            .flatten();
        if source.as_ref().is_none_or(|space| space.state.is_none())
            || (intent.plan.input.target_workspace.is_some()
                && target.as_ref().is_none_or(|space| space.state.is_none()))
        {
            // An operator may temporarily unregister a space outside the product.
            // Keep the receipt for a later restart and protect its surviving peer.
            for available in source
                .iter()
                .chain(target.iter())
                .filter_map(|space| space.state.as_ref())
            {
                available.fs_guard.require_storage_recovery();
            }
            tracing::warn!(operation=%id, "Workspace file recovery deferred until both spaces are available");
            continue;
        }
        let source = source.ok_or_else(changed)?;
        let ignore = |instance: &crate::multi::instance::SpaceInstance| -> Result<_, ApiError> {
            Ok(GitignoreMatcher::from_patterns(
                Path::new(&state(instance)?.space_folder_path),
                &instance.config.space_ignore,
            ))
        };
        let source_ignore = ignore(&source)?;
        let target_ignore = target.as_deref().map(ignore).transpose()?;
        let actor = Actor {
            username: Some(intent.account.clone()),
            ..Default::default()
        };
        let source = Endpoint {
            state: state(&source)?,
            workspace: &intent.workspace,
            actor: &actor,
            ignore: &source_ignore,
        };
        let target = target
            .as_ref()
            .zip(intent.plan.input.target_workspace.as_deref())
            .zip(target_ignore.as_ref())
            .map(|((instance, workspace), ignore)| {
                Ok::<_, ApiError>(Endpoint {
                    state: state(instance)?,
                    workspace,
                    actor: &actor,
                    ignore,
                })
            })
            .transpose()?;
        let outcome = if intent.status == "undoing" {
            managed_engine(source.state)?
                .with_managed_write(|tx| restore(&service.metadata, &source, &intent, tx, true))
        } else {
            with_locks(
                &source,
                target.as_ref(),
                intent.plan.input.action,
                |st, tt| {
                    execute(
                        &service.metadata,
                        &intent,
                        &source,
                        target.as_ref(),
                        st,
                        tt,
                        true,
                    )
                },
            )
        };
        if let Err(err) = outcome {
            // Preserve concurrent outside edits. If both copies exist, the
            // source retains its ID and the destination gets its own on listing.
            if matches!(
                err.code(),
                "file_action_changed" | "path_exists" | "not_found" | "needs_repair"
            ) {
                if intent.status == "undoing" {
                    reset_conflicted_undo(&service.metadata, &mut intent)?;
                } else {
                    recover_move_conflict(&service.metadata, &source, &intent)?;
                    set_status(&service.metadata, &intent, "conflict")?;
                }
                tracing::warn!(operation=%id,"Outside file edits preserved during directory action recovery");
            } else {
                return Err(err);
            }
        }
    }
    Ok(())
}
