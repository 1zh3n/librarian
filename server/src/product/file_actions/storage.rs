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

    fn vacant_restore_path(&self, plan: &Plan) -> Result<(), ApiError> {
        let path = plan.restore_root();
        let folder = plan.input.source_kind == Kind::Folder;
        if !super::visible_path(self.ignore, path, folder) {
            return Err(ApiError::invalid(
                "Choose a visible, safe relative workspace path",
            ));
        }
        for (slash, _) in path.match_indices('/') {
            match self.attr(&path[..slash]) {
                Ok(Some(attr)) if attr.is_dir() => {}
                Ok(None) if plan.restore_path.is_none() => {
                    return Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "restore_location_unavailable",
                        "The original folder no longer exists. Choose another location.",
                    ))
                }
                Ok(None) => return Err(changed()),
                Ok(Some(_)) => return Err(path_exists()),
                Err(e) if e.status() == StatusCode::NOT_FOUND => return Err(path_exists()),
                Err(e) => return Err(e),
            }
        }
        self.vacant(path, plan.input.source_kind).map_err(|error| {
            if error.status() == StatusCode::NOT_FOUND {
                path_exists()
            } else {
                error
            }
        })
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

fn parent_identity(root: &Path, path: &str) -> Result<Identity, ApiError> {
    let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
    crate::product::documents::check_native_path(root, parent)?;
    match fs::symlink_metadata(root.join(parent)) {
        Ok(attr) if attr.is_dir() => Ok(Identity::from(&attr)),
        Ok(_) => Err(path_exists()),
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Err(changed())
        }
        Err(e) => Err(ApiError::internal(e)),
    }
}

// A mutation may roll back uncommitted writes before the file action journal
// is reconciled. Even identical bytes in a replacement parent belong to its owner.
pub(in crate::product) fn undo_rollback_allowed(
    metadata: &Metadata,
    root: &Path,
    step: &str,
) -> Result<bool, ApiError> {
    let saved: Option<String> = metadata.connection()?.query_row(
        "SELECT plan FROM workspace_file_actions WHERE status='undoing' AND json_extract(plan,'$.undo_step')=?",
        [step],
        |row| row.get(0),
    ).optional()?;
    let Some(saved) = saved else { return Ok(true) };
    let plan: Plan = serde_json::from_str(&saved).map_err(ApiError::internal)?;
    let Some(expected) = &plan.restore_parent else {
        return Ok(false);
    };
    match parent_identity(root, plan.restore_root()) {
        Ok(found) => Ok(found == *expected),
        Err(e)
            if matches!(
                e.code(),
                "file_action_changed" | "path_exists" | "not_found"
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e),
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
    #[serde(default)]
    target_path: Option<String>,
    #[serde(default)]
    copy_only: bool,
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

fn add_referenced_images(
    source: &Endpoint<'_>,
    input: &Input,
    inventory: &mut Inventory,
) -> Result<(), ApiError> {
    if input.source_kind != Kind::Document {
        return Ok(());
    }
    let Some(target_path) = input.target_path.as_deref() else {
        return Ok(());
    };
    let source_dir = input
        .source_path
        .rsplit_once('/')
        .map_or("", |(dir, _)| dir);
    let target_dir = target_path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let target_workspace = input
        .target_workspace
        .as_deref()
        .unwrap_or(source.workspace);
    if source.workspace == target_workspace && source_dir == target_dir {
        return Ok(());
    }
    let markdown = String::from_utf8(source.bytes(&input.source_path)?).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_image_reference",
            "Markdown must be UTF-8 before moving image references",
        )
    })?;
    let mut total = 0usize;
    for item in inventory.files() {
        total += source
            .attr(&item.path)?
            .map_or(0, |attr| attr.len() as usize);
    }
    let parser = pulldown_cmark::Parser::new_ext(
        &markdown,
        pulldown_cmark::Options::ENABLE_YAML_STYLE_METADATA_BLOCKS,
    );
    for event in parser {
        match event {
            pulldown_cmark::Event::Html(html) | pulldown_cmark::Event::InlineHtml(html)
                if html.to_ascii_lowercase().contains("<img") =>
            {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unsupported_image_reference",
                    "Moving a document with a local HTML img is not supported",
                ));
            }
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image { dest_url, .. }) => {
                let dest_url = dest_url
                    .split(['?', '#'])
                    .next()
                    .unwrap_or(dest_url.as_ref());
                if dest_url.is_empty() {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "unsupported_image_reference",
                        "Image reference is empty",
                    ));
                }
                if dest_url.starts_with("http://")
                    || dest_url.starts_with("https://")
                    || dest_url.starts_with("data:")
                    || dest_url.starts_with('#')
                    || dest_url.starts_with("mailto:")
                    || dest_url.starts_with('/')
                {
                    continue;
                }
                let Some(source_path) = resolve_relative(source_dir, dest_url) else {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "unsupported_image_reference",
                        "Image reference escapes the workspace",
                    ));
                };
                let Some(destination) = resolve_relative(target_dir, dest_url) else {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "unsupported_image_reference",
                        "Image reference escapes the target workspace",
                    ));
                };
                if source_path == destination && source.workspace == target_workspace {
                    continue;
                }
                let metadata = source.attr(&source_path)?.ok_or_else(|| {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "unsupported_image_reference",
                        "Referenced image does not exist",
                    )
                })?;
                if inventory.items.iter().any(|item| {
                    item.path == source_path
                        && item.target_path.as_deref() == Some(destination.as_str())
                }) {
                    continue;
                }
                let bytes = source.bytes(&source_path)?;
                total = total.saturating_add(bytes.len());
                if total > mutations::MAX_BATCH_BYTES {
                    return Err(asset_batch_too_large());
                }
                inventory.items.push(Item {
                    path: source_path,
                    object: Identity::from(&metadata),
                    revision: Some(sha256_hex(&bytes)),
                    document: None,
                    target_path: Some(destination),
                    copy_only: true,
                });
            }
            _ => {}
        }
    }
    Ok(())
}

fn resolve_relative(base: &str, path: &str) -> Option<String> {
    let path = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?;
    let mut parts = base
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part if part.contains('\\') || part.contains(':') => return None,
            part => parts.push(part.to_owned()),
        }
    }
    let path = parts.join("/");
    (mutations::valid_file_path(&path) && path.split('/').all(|part| !part.starts_with('.')))
        .then_some(path)
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
            target_path: None,
            copy_only: false,
        });
    }
    items.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(Inventory {
        items,
        target_parent: None,
    })
}

fn destination(input: &Input, path: &str) -> String {
    mapped_path(&input.source_path, input.target_path.as_deref(), path)
}

fn item_destination(input: &Input, item: &Item) -> String {
    item.target_path
        .clone()
        .unwrap_or_else(|| destination(input, &item.path))
}

fn mapped_path(original: &str, target: Option<&str>, path: &str) -> String {
    let Some(target) = target else {
        return path.to_owned();
    };
    if let Some(tail) = path.strip_prefix(original) {
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
    add_referenced_images(source, input, &mut inventory)?;
    if let Some(target) = target {
        let dst = input
            .target_path
            .as_deref()
            .ok_or_else(|| ApiError::invalid("Missing destination"))?;
        let src = &input.source_path;
        let additions = inventory.file_count();
        let removals = inventory.files().filter(|item| !item.copy_only).count();
        let combined = input.action == Action::Move && source.workspace == target.workspace;
        if additions > mutations::MAX_FILES
            || (combined && additions + removals > mutations::MAX_FILES)
        {
            return if inventory.items.iter().any(|item| item.copy_only) {
                Err(too_many_referenced_assets())
            } else {
                Err(too_large())
            };
        }
        if source.workspace == target.workspace {
            if src == dst
                || dst.starts_with(&format!("{src}/"))
                || src.starts_with(&format!("{dst}/"))
            {
                return Err(ApiError::invalid("Source and destination must not overlap"));
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
            let path = item_destination(input, item);
            validate_path(target.state, target.ignore, &path, item.revision.is_none())?;
            if item.copy_only && target.attr(&path)?.is_some() {
                return Err(path_exists());
            }
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
        CREATE TABLE IF NOT EXISTS completed_file_deletions (
            sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES workspace_file_actions(operation_id));
        CREATE INDEX IF NOT EXISTS deleted_file_actions ON workspace_file_actions(workspace,account)
            WHERE status='done' AND json_extract(plan,'$.input.action')='delete';
        CREATE TABLE IF NOT EXISTS file_action_outputs(step TEXT PRIMARY KEY, objects TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS empty_directory_steps(id TEXT PRIMARY KEY, object TEXT);
        CREATE TABLE IF NOT EXISTS restored_document_history (
            workspace TEXT NOT NULL, document TEXT NOT NULL, restore_commit TEXT NOT NULL,
            deletion_commit TEXT NOT NULL, path TEXT NOT NULL,
            UNIQUE(workspace,document,restore_commit));",
    )?;
    let has_restore_path: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('restored_document_history') WHERE name='restore_path')",
        [],
        |row| row.get(0),
    )?;
    if !has_restore_path {
        tx.execute_batch("ALTER TABLE restored_document_history ADD COLUMN restore_path TEXT")?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Plan {
    input: Input,
    inventory: Inventory,
    destination_ids: Vec<String>,
    source_step: String,
    target_step: String,
    undo_step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_parent: Option<Identity>,
}

impl Plan {
    fn restored_path(&self, path: &str) -> String {
        mapped_path(&self.input.source_path, self.restore_path.as_deref(), path)
    }

    fn restore_root(&self) -> &str {
        self.restore_path
            .as_deref()
            .unwrap_or(&self.input.source_path)
    }
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
            path: if undo {
                self.plan.restore_root().into()
            } else {
                input
                    .target_path
                    .as_ref()
                    .unwrap_or(&input.source_path)
                    .clone()
            },
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
                    restore_path: None,
                    restore_parent: None,
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
        .filter(|item| !item.copy_only)
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
                path: item_destination(&plan.input, item),
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

fn create_dirs(
    endpoint: &Endpoint<'_>,
    plan: &Plan,
    restoring: bool,
    can_create: bool,
) -> Result<(), ApiError> {
    for dir in plan.inventory.dirs() {
        let path = if restoring {
            plan.restored_path(&dir.path)
        } else {
            destination(&plan.input, &dir.path)
        };
        match endpoint.attr(&path)? {
            Some(attr) if attr.is_dir() => continue,
            Some(_) => return Err(path_exists()),
            None if !can_create => return Err(changed()),
            None => {}
        }
        fs::create_dir(endpoint.root().join(path)).map_err(|e| match e.kind() {
            ErrorKind::AlreadyExists | ErrorKind::NotADirectory => path_exists(),
            ErrorKind::NotFound => changed(),
            _ => ApiError::internal(e),
        })?;
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

fn empty_identity(metadata: &Metadata, step: &str) -> Result<Identity, ApiError> {
    let object: String = metadata.connection()?.query_row(
        "SELECT object FROM empty_directory_steps WHERE id=?",
        [step],
        |row| row.get(0),
    )?;
    serde_json::from_str(&object).map_err(ApiError::internal)
}

fn publish_empty(
    metadata: &Metadata,
    target: &Endpoint<'_>,
    step: &str,
    path: &str,
    can_publish: bool,
) -> Result<(), ApiError> {
    let object = empty_identity(metadata, step)?;
    if let Some(attr) = target.attr(path)? {
        return if attr.is_dir() && Identity::from(&attr) == object {
            Ok(())
        } else {
            Err(path_exists())
        };
    }
    if !can_publish {
        return Err(changed());
    }
    let stage = target.root().join(format!(".librarian-directory-{step}"));
    let attr = target
        .attr(&format!(".librarian-directory-{step}"))?
        .ok_or_else(changed)?;
    if !attr.is_dir() || Identity::from(&attr) != object {
        return Err(changed());
    }
    crate::multi::migrate::execute::rename_no_replace(&stage, &target.root().join(path)).map_err(
        |e| {
            if matches!(
                e.kind(),
                ErrorKind::AlreadyExists | ErrorKind::NotADirectory
            ) {
                path_exists()
            } else if e.kind() == ErrorKind::NotFound {
                changed()
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
            plan.restored_path(&item.path)
        } else {
            item_destination(&plan.input, item)
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
        let dest = if undo {
            plan.restored_path(&item.path)
        } else {
            destination(&plan.input, &item.path)
        };
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
            tx.execute("INSERT INTO restored_document_history(workspace, document, restore_commit, deletion_commit, path, restore_path)
                        VALUES(?, ?, ?, ?, ?, ?)",params![intent.workspace,id,restored,deleted,item.path,dest])?;
        }
    }
    if plan.input.action == Action::Delete && !undo {
        tx.execute(
            "INSERT INTO completed_file_deletions(operation_id) VALUES(?)",
            [&intent.id],
        )?;
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
    let mut current = source_tree(metadata, source, &plan.input, None).map_err(stale)?;
    add_referenced_images(source, &plan.input, &mut current).map_err(stale)?;
    if current.items != plan.inventory.items {
        return Err(changed());
    }
    Ok(())
}

fn too_many_referenced_assets() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "too_many_referenced_assets",
        "The document references too many files to move in one operation",
    )
}

fn asset_batch_too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "asset_batch_too_large",
        "The document's referenced images exceed the batch size limit",
    )
}

fn stale(err: ApiError) -> ApiError {
    if err.code() == "unsupported_image_reference" {
        err
    } else if err.is_file_conflict() || err.code() == "path_exists" {
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
                publish_empty(metadata, target, &plan.target_step, dst, true)?;
            } else {
                verify_outputs(metadata, target, plan, &plan.target_step, false)?;
                create_dirs(target, plan, false, true)?;
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

pub(super) fn deleted(
    metadata: &Metadata,
    account: &str,
    workspace: &str,
) -> Result<Vec<super::DeletedItem>, ApiError> {
    let db = metadata.connection()?;
    // Earlier installs stored intent order. New records also track the commit
    // order, which can differ when an unpublished deletion is retried later.
    let mut query = db.prepare(
        "SELECT a.operation_id, json_extract(a.plan,'$.input.sourcePath'), json_extract(a.plan,'$.input.sourceKind'),
                (SELECT count(*) FROM json_each(a.plan,'$.inventory.items') AS item
                 WHERE json_extract(item.value,'$.revision') IS NOT NULL)
         FROM workspace_file_actions a LEFT JOIN completed_file_deletions c ON c.operation_id=a.operation_id
         WHERE a.workspace=? AND a.account=? AND a.status='done' AND json_extract(a.plan,'$.input.action')='delete'
         ORDER BY c.sequence DESC, a.rowid DESC"
    )?;
    let rows = query
        .query_map(params![workspace, account], |row| {
            let kind: String = row.get(2)?;
            let source_kind = match kind.as_str() {
                "document" => Kind::Document,
                "folder" => Kind::Folder,
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            Ok(super::DeletedItem {
                operation_id: row.get(0)?,
                path: row.get(1)?,
                source_kind,
                file_count: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub(super) fn undo(
    metadata: &Metadata,
    account: &str,
    source: &Endpoint<'_>,
    operation: &str,
    target_path: Option<&str>,
) -> Result<ActionResult, ApiError> {
    let mut intent = Intent::get(metadata, operation)?
        .filter(|i| {
            i.account == account
                && i.workspace == source.workspace
                && i.plan.input.action == Action::Delete
        })
        .ok_or_else(ApiError::not_found)?;
    managed_engine(source.state)?.with_managed_write(|tx| {
        check_storage_recovery(source.state)?;
        let destination = target_path.unwrap_or(&intent.plan.input.source_path);
        if intent.status != "done" && destination != intent.plan.restore_root() {
            return Err(reused());
        }
        if intent.status == "undone" {
            return Ok(intent.result(true));
        }
        if !matches!(intent.status.as_str(), "done" | "undoing") {
            return Err(changed());
        }
        intent.plan.restore_path = target_path
            .filter(|path| *path != intent.plan.input.source_path)
            .map(str::to_owned);
        if intent.status == "done" {
            source.vacant_restore_path(&intent.plan)?;
            intent.plan.restore_parent = Some(parent_identity(source.root(), intent.plan.restore_root())?);
        }
        if let Err(error) = restore(metadata, source, &intent, tx, false) {
            // A failed pre-publication attempt may choose a new location. A
            // pending filesystem journal must first reconcile its own writes.
            if check_storage_recovery(source.state).is_ok() {
                let unopened: bool = metadata.connection()?.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspace_file_actions WHERE operation_id=?1 AND status='undoing')
                       AND NOT EXISTS(SELECT 1 FROM mutations WHERE operation_id=?2 AND state IN ('pending','committed'))
                       AND NOT EXISTS(SELECT 1 FROM empty_directory_steps WHERE id=?2)",
                    params![intent.id, intent.plan.undo_step],
                    |row| row.get(0),
                )?;
                if unopened {
                    reset_conflicted_undo(metadata, &mut intent)?;
                }
            }
            return Err(error);
        }
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
            let path = plan.restored_path(&item.path);
            validate_path(source.state, source.ignore, &path, false)?;
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
                path,
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
        source.vacant_restore_path(plan)?;
        {
            let connection = metadata.connection()?;
            for item in &plan.inventory.items {
                let path = plan.restored_path(&item.path);
                validate_path(source.state, source.ignore, &path, item.revision.is_none())?;
                if let Some(id) = &item.document {
                    let occupied:bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM documents WHERE id=? OR (workspace_id=? AND path=?))",
                        params![id,source.workspace,path], |row| row.get(0))?;
                    if occupied {
                        return Err(path_exists());
                    }
                }
            }
        }
        let edits = original_edits(metadata, source, intent, &plan.source_step)?;
        if Some(parent_identity(source.root(), plan.restore_root())?) != plan.restore_parent {
            return Err(changed());
        }
        let saved = serde_json::to_string(plan).map_err(ApiError::internal)?;
        metadata.connection()?.execute(
            "UPDATE workspace_file_actions SET plan=?,status='undoing' WHERE operation_id=?",
            params![saved, intent.id],
        )?;
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
    let result = (|| {
        // Older interrupted undos have no parent witness. They may finish an
        // already materialized tree, but may not publish into a new parent.
        let can_publish = if let Some(expected) = &plan.restore_parent {
            if parent_identity(source.root(), plan.restore_root())? != *expected {
                return Err(changed());
            }
            true
        } else {
            false
        };
        if plan.inventory.file_count() == 0 {
            publish_empty(
                metadata,
                source,
                &plan.undo_step,
                plan.restore_root(),
                can_publish,
            )?;
            create_dirs(source, plan, true, false)?;
        } else {
            verify_outputs(metadata, source, plan, &plan.undo_step, true)?;
            create_dirs(source, plan, true, can_publish)?;
        }
        finish(metadata, intent, true)
    })();
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
        return publish_empty(
            metadata,
            source,
            &plan.undo_step,
            &plan.input.source_path,
            true,
        );
    }
    verify_outputs(metadata, source, plan, &plan.undo_step, true)?;
    create_dirs(source, plan, true, true)?;
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

// Remove only empty directories belonging to our recorded private staging
// root. Foreign files or substituted trees are left in place.
fn discard_empty_stage(
    metadata: &Metadata,
    source: &Endpoint<'_>,
    plan: &Plan,
) -> Result<(), ApiError> {
    if plan.inventory.file_count() != 0 {
        return Ok(());
    }
    let name = format!(".librarian-directory-{}", plan.undo_step);
    let attr = match fs::symlink_metadata(source.root().join(&name)) {
        Ok(attr) => attr,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(ApiError::internal(e)),
    };
    if !attr.is_dir() || Identity::from(&attr) != empty_identity(metadata, &plan.undo_step)? {
        return Ok(());
    }
    for dir in plan.inventory.dirs().rev() {
        let staged = mapped_path(&plan.input.source_path, Some(&name), &dir.path);
        match source.attr(&staged) {
            Ok(Some(attr)) if attr.is_dir() => {}
            Ok(_) => continue,
            Err(e) if e.is_file_conflict() || e.code() == "path_exists" => continue,
            Err(e) => return Err(e),
        }
        match fs::remove_dir(source.root().join(staged)) {
            Ok(()) => {}
            Err(e) if matches!(e.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::NotFound) => {}
            Err(e) => return Err(ApiError::internal(e)),
        }
    }
    Ok(())
}

fn reset_conflicted_undo(metadata: &Metadata, intent: &mut Intent) -> Result<(), ApiError> {
    intent.plan.undo_step = new_id();
    intent.plan.restore_path = None;
    intent.plan.restore_parent = None;
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
fn needs_files(metadata: &Metadata, intent: &mut Intent) -> Result<bool, ApiError> {
    let plan = &intent.plan;
    if intent.status == "undoing" {
        if completed_step(metadata, &intent.workspace, intent, &plan.undo_step)? {
            return Ok(true);
        }
        reset_conflicted_undo(metadata, intent)?;
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
        let mut intent = Intent::get(metadata, &id)?.ok_or_else(changed)?;
        if needs_files(metadata, &mut intent)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(in crate::product) fn recover(service: &DocumentService) -> Result<(), ApiError> {
    for id in pending_ids(&service.metadata, None)? {
        let mut intent = Intent::get(&service.metadata, &id)?.ok_or_else(changed)?;
        if !needs_files(&service.metadata, &mut intent)? {
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
                    discard_empty_stage(&service.metadata, &source, &intent.plan)?;
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
