use std::{collections::BTreeMap, fs, io, path::Path, sync::Arc};

use axum::{
    extract::{rejection::JsonRejection, Path as RoutePath, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::space::GitignoreMatcher;

use crate::{
    auth::{AccessLevel, Actor},
    multi::{data_root, instance::SpaceInstance},
    state::ServerState,
};

use super::{
    auth::{effective_level, Account},
    contract::ApiError,
    documents::{
        body, check_file_path, native_path_has_no_links, product_read, product_write, run, state,
        DocumentService,
    },
    mutations, workspace,
};

pub(super) mod storage;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    Move,
    Copy,
    Delete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Kind {
    Document,
    Folder,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Input {
    pub(super) action: Action,
    pub(super) source_kind: Kind,
    pub(super) source_path: String,
    pub(super) expected_document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) expected_folder_id: Option<String>,
    pub(super) target_workspace: Option<String>,
    pub(super) target_path: Option<String>,
}

impl Input {
    fn resolve_destination(&mut self, workspace: &str) {
        if self.action != Action::Delete && self.target_workspace.is_none() {
            self.target_workspace = Some(workspace.to_owned());
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActionResult {
    pub(super) operation_id: String,
    pub(super) workspace_id: String,
    pub(super) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) document_id: Option<String>,
    pub(super) undoable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Apply {
    pub(super) operation_id: String,
    pub(super) token: String,
    #[serde(flatten)]
    pub(super) input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Undo {
    operation_id: String,
    target_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletedItem {
    operation_id: String,
    path: String,
    source_kind: Kind,
    file_count: i64,
}

#[derive(Serialize)]
struct DeletedList {
    items: Vec<DeletedItem>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccessChanges {
    gained_read: usize,
    gained_write: usize,
    lost: usize,
    upgraded: usize,
    downgraded: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preview {
    pub(super) token: String,
    pub(super) file_count: usize,
    pub(super) access: AccessChanges,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Folder {
    path: String,
}

#[derive(Serialize)]
struct FolderList {
    folders: Vec<String>,
    identities: BTreeMap<String, String>,
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route(
            "/workspaces/{workspace}/folders",
            get(folders).post(create_folder),
        )
        .route(
            "/workspaces/{workspace}/file-actions/preview",
            post(preview),
        )
        .route("/workspaces/{workspace}/file-actions/apply", post(apply))
        .route("/workspaces/{workspace}/file-actions/undo", post(undo))
        .route("/workspaces/{workspace}/file-actions/deleted", get(deleted))
}

struct Scope<'a> {
    workspace: &'a str,
    instance: Arc<SpaceInstance>,
    actor: Actor,
    ignore: GitignoreMatcher,
}

impl<'a> Scope<'a> {
    fn open(
        service: &DocumentService,
        account: &Account,
        workspace: &'a str,
        write: bool,
    ) -> Result<Self, ApiError> {
        let (instance, actor) = service.scope(account, workspace, write)?;
        let ignore = GitignoreMatcher::from_patterns(
            Path::new(&state(&instance)?.space_folder_path),
            &instance.config.space_ignore,
        );
        Ok(Self {
            workspace,
            instance,
            actor,
            ignore,
        })
    }

    fn managed(&self) -> Result<(), ApiError> {
        if self
            .instance
            .revisions
            .as_ref()
            .is_some_and(|engine| engine.store().auto_commit_allowed())
        {
            return Ok(());
        }
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "revisions_read_only",
            "This file action requires managed workspace versions",
        ))
    }

    fn endpoint(&self) -> Result<storage::Endpoint<'_>, ApiError> {
        Ok(storage::Endpoint {
            state: state(&self.instance)?,
            workspace: self.workspace,
            actor: &self.actor,
            ignore: &self.ignore,
        })
    }
}

struct Scopes<'a> {
    source: Scope<'a>,
    target: Option<Scope<'a>>,
}

impl<'a> Scopes<'a> {
    fn open(
        service: &DocumentService,
        account: &Account,
        workspace_id: &'a str,
        input: &'a Input,
    ) -> Result<Self, ApiError> {
        let source = Scope::open(service, account, workspace_id, input.action != Action::Copy)?;
        if input.action == Action::Move {
            workspace::require_manage(service, account, workspace_id)?;
        }
        if input.action != Action::Copy {
            source.managed()?;
        }
        if input.source_kind == Kind::Folder && input.expected_document_id.is_some() {
            return Err(ApiError::invalid("Only documents have a document ID"));
        }
        if input.source_kind == Kind::Document && input.expected_folder_id.is_some() {
            return Err(ApiError::invalid("Only folders have a folder ID"));
        }
        let target = match input.action {
            Action::Delete => {
                if input.target_workspace.is_some() || input.target_path.is_some() {
                    return Err(ApiError::invalid(
                        "A delete action cannot have a destination",
                    ));
                }
                None
            }
            Action::Move | Action::Copy => {
                if input.target_path.is_none() {
                    return Err(ApiError::invalid("Select a destination path"));
                }
                let scope = Scope::open(
                    service,
                    account,
                    input.target_workspace.as_deref().unwrap_or(workspace_id),
                    true,
                )?;
                scope.managed()?;
                Some(scope)
            }
        };
        Ok(Self { source, target })
    }

    fn preview(
        &self,
        service: &DocumentService,
        account: &Account,
        input: &Input,
        inventory: &storage::Inventory,
    ) -> Result<Preview, ApiError> {
        let mut roles = BTreeMap::new();
        let mut access = AccessChanges::default();
        for username in service.spaces.users.usernames() {
            let before = effective_level(&service.spaces, &self.source.instance, &username)?;
            let after = match &self.target {
                Some(target) => effective_level(&service.spaces, &target.instance, &username)?,
                None => before,
            };
            if before == AccessLevel::None && after == AccessLevel::None {
                continue;
            }
            roles.insert(username, (role_name(before), role_name(after)));
            match (before, after) {
                (AccessLevel::None, AccessLevel::Read) => access.gained_read += 1,
                (AccessLevel::None, AccessLevel::Write) => access.gained_write += 1,
                (AccessLevel::Read | AccessLevel::Write, AccessLevel::None) => access.lost += 1,
                (AccessLevel::Read, AccessLevel::Write) => access.upgraded += 1,
                (AccessLevel::Write, AccessLevel::Read) => access.downgraded += 1,
                _ => {}
            }
        }
        // Keep member identities on the server. The token binds their exact roles, the actor
        // and the complete file inventory, and remains verifiable across server restarts.
        let binding = serde_json::to_string(&(
            "librarian/file-actions/preview/v1",
            account.username(),
            self.source.workspace,
            input,
            roles,
            inventory,
        ))
        .map_err(ApiError::internal)?;
        let token = service.spaces.authenticator.csrf_token(&binding);
        Ok(Preview {
            token,
            access,
            file_count: inventory.file_count(),
        })
    }
}

fn role_name(level: AccessLevel) -> &'static str {
    match level {
        AccessLevel::None => "none",
        AccessLevel::Read => "read",
        AccessLevel::Write => "write",
    }
}

pub(super) fn changed() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "file_action_changed",
        "The selection or workspace access changed. Review the action again",
    )
}

pub(super) fn path_exists() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "path_exists",
        "The destination path already exists",
    )
}

fn validate_operation(id: &str) -> Result<(), ApiError> {
    if uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        Err(ApiError::invalid("Expected a canonical operation UUID"))
    }
}

fn visible_path(ignore: &GitignoreMatcher, path: &str, is_dir: bool) -> bool {
    mutations::valid_file_path(path)
        && !path
            .split('/')
            .any(|part| part.starts_with('.') || data_root::reserved_dir(part).is_some())
        && !path
            .split('/')
            .next()
            .is_some_and(data_root::is_reserved_top_level)
        && !ignore.is_ignored(path, is_dir)
}

pub(super) fn validate_path(
    state: &ServerState,
    ignore: &GitignoreMatcher,
    path: &str,
    is_dir: bool,
) -> Result<(), ApiError> {
    if !visible_path(ignore, path, is_dir) {
        return Err(ApiError::invalid(
            "Choose a visible, safe relative workspace path",
        ));
    }
    check_file_path(state, path)
}

// Derive a purpose-specific HMAC key from the installation secret. Directory handles
// stay stable across restarts and disclose neither inode numbers nor their device.
fn folder_key(service: &DocumentService) -> String {
    service
        .spaces
        .authenticator
        .csrf_token("librarian/folder-identity/key/v1")
}

async fn preview(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Json<Preview>, ApiError> {
    let mut input = body(input)?;
    input.resolve_destination(&workspace);
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = Account::authenticate(&service.spaces, &headers, true)?;
        preview_action(&service, &account, &workspace, &input)
    })
    .await
    .map(Json)
}

/// The caller holds the workspace guard through authorization and the file operation.
pub(super) fn preview_action(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    input: &Input,
) -> Result<Preview, ApiError> {
    let scopes = Scopes::open(service, account, workspace, input)?;
    let source = scopes.source.endpoint()?;
    let target = scopes.target.as_ref().map(Scope::endpoint).transpose()?;
    let _source_lock = product_read(source.state)?;
    let _target_lock = target
        .as_ref()
        .filter(|target| target.workspace != source.workspace)
        .map(|target| product_read(target.state))
        .transpose()?;
    let inventory = storage::inspect(
        &service.metadata,
        &source,
        target.as_ref(),
        input,
        &folder_key(service),
    )?;
    scopes.preview(service, account, input, &inventory)
}

async fn apply(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    request: Result<Json<Apply>, JsonRejection>,
) -> Result<Json<ActionResult>, ApiError> {
    let mut request = body(request)?;
    request.input.resolve_destination(&workspace);
    validate_operation(&request.operation_id)?;
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = Account::authenticate(&service.spaces, &headers, true)?;
        apply_action(&service, &account, &workspace, &request)
    })
    .await
    .map(Json)
}

/// The caller holds the workspace guard through authorization and the file operation.
pub(super) fn apply_action(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    request: &Apply,
) -> Result<ActionResult, ApiError> {
    let scopes = Scopes::open(service, account, workspace, &request.input)?;
    let source = scopes.source.endpoint()?;
    let target = scopes.target.as_ref().map(Scope::endpoint).transpose()?;
    storage::apply(
        &service.metadata,
        account.username(),
        &source,
        target.as_ref(),
        request,
        &folder_key(service),
        |inventory| {
            let current = scopes.preview(service, account, &request.input, inventory)?;
            if current.token == request.token {
                Ok(())
            } else {
                Err(changed())
            }
        },
    )
}

async fn deleted(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Json<DeletedList>, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = Account::authenticate(&service.spaces, &headers, false)?;
        let scope = Scope::open(&service, &account, &workspace, true)?;
        scope.managed()?;
        let _read = product_read(state(&scope.instance)?)?;
        let items = storage::deleted(&service.metadata, account.username(), &workspace)?;
        Ok(DeletedList { items })
    })
    .await
    .map(Json)
}

async fn undo(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    request: Result<Json<Undo>, JsonRejection>,
) -> Result<Json<ActionResult>, ApiError> {
    let request = body(request)?;
    validate_operation(&request.operation_id)?;
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = Account::authenticate(&service.spaces, &headers, true)?;
        let scope = Scope::open(&service, &account, &workspace, true)?;
        scope.managed()?;
        storage::undo(
            &service.metadata,
            account.username(),
            &scope.endpoint()?,
            &request.operation_id,
            request.target_path.as_deref(),
        )
    })
    .await
    .map(Json)
}

async fn folders(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Json<FolderList>, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = Account::authenticate(&service.spaces, &headers, false)?;
        let scope = Scope::open(&service, &account, &workspace, false)?;
        let state = state(&scope.instance)?;
        let _lock = product_read(state)?;
        let root = Path::new(&state.space_folder_path);
        let key = folder_key(&service);
        let mut identities = BTreeMap::new();
        let mut pending = vec![String::new()];
        while let Some(parent) = pending.pop() {
            let location = root.join(&parent);
            let entries = if parent.is_empty() {
                fs::read_dir(&location).map_err(ApiError::internal)?
            } else {
                if nested_entry(native_path_has_no_links(root, &parent))? != Some(true) {
                    continue;
                }
                let Some(entries) = nested_entry(fs::read_dir(&location))? else {
                    continue;
                };
                let Some(metadata) = nested_entry(fs::symlink_metadata(&location))? else {
                    continue;
                };
                if !metadata.is_dir() {
                    continue;
                }
                identities.insert(
                    parent.clone(),
                    storage::folder_id(&key, &workspace, &parent, &metadata)?,
                );
                entries
            };
            for entry in entries {
                let Some(entry) = nested_entry(entry)? else {
                    continue;
                };
                if !nested_entry(entry.file_type())?.is_some_and(|kind| kind.is_dir()) {
                    continue;
                }
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                let path = if parent.is_empty() {
                    name
                } else {
                    format!("{parent}/{name}")
                };
                if visible_path(&scope.ignore, &path, true) {
                    pending.push(path);
                }
            }
        }
        Ok(FolderList {
            folders: identities.keys().cloned().collect(),
            identities,
        })
    })
    .await
    .map(Json)
}

fn nested_entry<T>(result: io::Result<T>) -> Result<Option<T>, ApiError> {
    match result {
        Ok(entry) => Ok(Some(entry)),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::PermissionDenied
                    | io::ErrorKind::NotFound
                    | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(ApiError::internal(error)),
    }
}

async fn create_folder(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    input: Result<Json<Folder>, JsonRejection>,
) -> Result<Json<Folder>, ApiError> {
    let folder = body(input)?;
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = Account::authenticate(&service.spaces, &headers, true)?;
        let scope = Scope::open(&service, &account, &workspace, true)?;
        let state = state(&scope.instance)?;
        let _lock = product_write(state)?;
        validate_path(state, &scope.ignore, &folder.path, true)?;
        fs::create_dir(Path::new(&state.space_folder_path).join(&folder.path)).map_err(
            |e| match e.kind() {
                io::ErrorKind::AlreadyExists | io::ErrorKind::NotADirectory => path_exists(),
                io::ErrorKind::NotFound => ApiError::not_found(),
                _ => ApiError::internal(e),
            },
        )?;
        Ok(folder)
    })
    .await
    .map(Json)
}
