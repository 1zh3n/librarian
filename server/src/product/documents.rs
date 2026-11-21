use std::{
    io,
    path::Path,
    sync::{Arc, RwLockReadGuard, RwLockWriteGuard},
};

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Path as RoutePath, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use silverbullet_server_common::{revision::sha256_hex, FileMeta, SpaceError};

use crate::{auth::Actor, multi::instance::SpaceInstance, state::ServerState};

use super::{
    auth::Account,
    contract::{
        ApiError, CreateDocument, DocumentSnapshot, DocumentSummary, OutlineSnapshot, Workspace,
        WriteMarkdown,
    },
    db::Metadata,
    space_adapter::NativeSpaces,
};

pub(super) const MARKDOWN_LIMIT: usize = 4 * 1024 * 1024;
const METADATA_LIMIT: usize = 32 * 1024;

pub(crate) struct DocumentService {
    pub(super) reader_links: super::reader_links::ReaderLinks,
    pub(crate) spaces: NativeSpaces,
    pub(super) metadata: Metadata,
    pub(super) ai_discovery: super::ai_settings::AiDiscoveryService,
}

impl DocumentService {
    pub(crate) fn open(root: &Path, spaces: NativeSpaces) -> Result<Self, String> {
        let metadata = Metadata::open(root)?;
        Ok(Self {
            reader_links: super::reader_links::ReaderLinks::load(&metadata)?,
            ai_discovery: super::ai_settings::AiDiscoveryService::open(&metadata)?,
            metadata,
            spaces,
        })
    }

    pub(crate) fn scope(
        &self,
        account: &Account,
        workspace: &str,
        write: bool,
    ) -> Result<(Arc<SpaceInstance>, Actor), ApiError> {
        let space_id = self.metadata.space_id(workspace)?;
        super::workspace::ensure_active(&self.metadata, workspace)?;
        let instance = self
            .spaces
            .manager
            .instance(&space_id)
            .ok_or_else(ApiError::not_found)?;
        let actor = account.actor(&self.spaces, &instance, write)?;
        Ok((instance, actor))
    }

    pub(super) fn document_scope(
        &self,
        account: &Account,
        document: &str,
        write: bool,
    ) -> Result<(Arc<SpaceInstance>, Actor, String, String), ApiError> {
        let (workspace, path) = self.metadata.document_path(document)?;
        let (instance, actor) = self.scope(account, &workspace, write)?;
        Ok((instance, actor, workspace, path))
    }

    pub(super) fn workspaces(&self, account: &Account) -> Result<Vec<Workspace>, ApiError> {
        let _workspace_guard = self.metadata.workspace_guard()?;
        let registry = self.spaces.manager.registry().current();
        let mut workspaces = Vec::new();
        for instance in registry.instances.values() {
            let Ok(actor) = account.actor(&self.spaces, instance, false) else {
                continue;
            };
            let workspace = super::workspace::describe(self, account, instance, &actor)?;
            if !super::workspace::expired(workspace.expires_at) {
                workspaces.push(workspace);
            }
        }
        workspaces.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
        Ok(workspaces)
    }

    pub(super) fn path_in(&self, workspace: &str, document: &str) -> Result<String, ApiError> {
        super::workspace::ensure_active(&self.metadata, workspace)?;
        let (actual, path) = self.metadata.document_path(document)?;
        if actual != workspace {
            return Err(ApiError::not_found());
        }
        Ok(path)
    }

    pub(super) fn list(
        &self,
        account: &Account,
        workspace: &str,
        query: DocumentList,
    ) -> Result<Vec<DocumentSummary>, ApiError> {
        if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
            return Err(ApiError::invalid("limit must be between 1 and 500"));
        }
        let (instance, _) = self.scope(account, workspace, false)?;
        let state = state(&instance)?;
        let _mutation = product_read(state)?;
        super::workspace::ensure_active(&self.metadata, workspace)?;
        let mut files = state.space.fetch_file_list()?;
        files.sort_unstable_by(|a, b| a.name.cmp(&b.name));

        files
            .into_iter()
            .filter(|file| is_document_path(&file.name))
            .filter(|file| query.after.as_ref().is_none_or(|after| file.name > *after))
            .filter(|file| check_file_path(state, &file.name).is_ok())
            .take(query.limit.unwrap_or(100))
            .map(|file| self.summary_from_meta(state, workspace, file.name, file.size))
            .collect()
    }

    fn summary_from_meta(
        &self,
        state: &ServerState,
        workspace: &str,
        path: String,
        bytes: i64,
    ) -> Result<DocumentSummary, ApiError> {
        let size = usize::try_from(bytes).unwrap_or(0).min(METADATA_LIMIT);
        let title = if size == 0 {
            None
        } else {
            state
                .space
                .read_file_range(&path, 0, size)
                .ok()
                .and_then(|(prefix, _)| title_from_front_matter(&prefix))
        };
        let id = self.metadata.document_id(workspace, &path)?;
        Ok(summary(state, workspace, id, path, title))
    }

    pub(super) fn summary_from_markdown(
        &self,
        state: &ServerState,
        workspace: &str,
        path: String,
        markdown: &str,
    ) -> Result<DocumentSummary, ApiError> {
        let id = self.metadata.document_id(workspace, &path)?;
        let title = title_from_front_matter(markdown.as_bytes());
        Ok(summary(state, workspace, id, path, title))
    }

    pub(super) fn snapshot(
        &self,
        state: &ServerState,
        workspace: &str,
        id: String,
        path: String,
        markdown: String,
        revision: String,
    ) -> DocumentSnapshot {
        let title = title_from_front_matter(markdown.as_bytes());
        DocumentSnapshot {
            link: self.reader_links.document(workspace, &id),
            document_id: id.clone(),
            path: path.clone(),
            document: summary(state, workspace, id, path, title),
            markdown,
            revision,
        }
    }

    pub(super) fn get(&self, account: &Account, id: &str) -> Result<DocumentSnapshot, ApiError> {
        let (workspace, _) = self.metadata.document_path(id)?;
        let (instance, _) = self.scope(account, &workspace, false)?;
        let state = state(&instance)?;
        let _mutation = product_read(state)?;
        let path = self.path_in(&workspace, id)?;
        let markdown = read_markdown(state, &path)?;
        let revision = sha256_hex(markdown.as_bytes());
        Ok(self.snapshot(state, &workspace, id.to_owned(), path, markdown, revision))
    }

    fn create(
        &self,
        account: &Account,
        workspace: &str,
        request: CreateDocument,
    ) -> Result<DocumentSnapshot, ApiError> {
        let (instance, actor) = self.scope(account, workspace, true)?;
        if request.content.precondition()?.is_some() {
            return Err(ApiError::invalid("Creation requires a null baseRevision"));
        }
        let path = request.path;
        if !is_document_path(&path) {
            return Err(ApiError::invalid(
                "Expected a relative Markdown document path",
            ));
        }
        let state = state(&instance)?;
        let _mutation = product_write(state)?;
        super::workspace::ensure_active(&self.metadata, workspace)?;
        let (markdown, revision) =
            save_locked(state, &path, request.content.markdown, None, actor)?;
        let id = self.metadata.document_id(workspace, &path)?;
        Ok(self.snapshot(state, workspace, id, path, markdown, revision))
    }

    fn edit(
        &self,
        account: &Account,
        id: &str,
        request: WriteMarkdown,
    ) -> Result<DocumentSnapshot, ApiError> {
        let (workspace, _) = self.metadata.document_path(id)?;
        let (instance, actor) = self.scope(account, &workspace, true)?;
        let expected = request
            .precondition()?
            .ok_or_else(|| ApiError::invalid("Saving requires a content revision"))?
            .to_owned();
        let state = state(&instance)?;
        let _mutation = product_write(state)?;
        let path = self.path_in(&workspace, id)?;
        let (markdown, revision) =
            save_locked(state, &path, request.markdown, Some(&expected), actor)?;
        Ok(self.snapshot(state, &workspace, id.to_owned(), path, markdown, revision))
    }

    pub(super) fn get_outline(
        &self,
        account: &Account,
        id: &str,
    ) -> Result<OutlineSnapshot, ApiError> {
        let (workspace, _) = self.metadata.document_path(id)?;
        let (instance, _) = self.scope(account, &workspace, false)?;
        let state = state(&instance)?;
        let _mutation = product_read(state)?;
        let path = self.path_in(&workspace, id)?;
        check_file_path(state, &path)?;
        state.space.get_file_meta(&path)?;
        let sidecar = outline_path(&path);
        check_file_path(state, &sidecar)?;
        match state.space.get_file_meta(&sidecar) {
            Ok(_) => {
                let markdown = read_markdown(state, &sidecar)?;
                Ok(OutlineSnapshot {
                    revision: Some(sha256_hex(markdown.as_bytes())),
                    markdown,
                })
            }
            Err(SpaceError::NotFound) => Ok(OutlineSnapshot {
                markdown: String::new(),
                revision: None,
            }),
            Err(error) => Err(error.into()),
        }
    }

    fn save_outline(
        &self,
        account: &Account,
        id: &str,
        request: WriteMarkdown,
    ) -> Result<OutlineSnapshot, ApiError> {
        let (workspace, _) = self.metadata.document_path(id)?;
        let (instance, actor) = self.scope(account, &workspace, true)?;
        let state = state(&instance)?;
        let expected = request.precondition()?.map(str::to_owned);
        let _mutation = product_write(state)?;
        let path = self.path_in(&workspace, id)?;
        check_file_path(state, &path)?;
        state.space.get_file_meta(&path)?;
        let (markdown, revision) = save_locked(
            state,
            &outline_path(&path),
            request.markdown,
            expected.as_deref(),
            actor,
        )?;
        Ok(OutlineSnapshot {
            markdown,
            revision: Some(revision),
        })
    }
}

pub(crate) fn state(instance: &SpaceInstance) -> Result<&ServerState, ApiError> {
    instance.state.as_deref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "space_unavailable",
            "Workspace is unavailable",
        )
    })
}

pub(super) fn product_read(state: &ServerState) -> Result<RwLockReadGuard<'_, ()>, ApiError> {
    let lock = state.fs_guard.mutation.read().map_err(ApiError::internal)?;
    check_storage_recovery(state)?;
    Ok(lock)
}

pub(super) fn product_write(state: &ServerState) -> Result<RwLockWriteGuard<'_, ()>, ApiError> {
    let lock = state
        .fs_guard
        .mutation
        .write()
        .map_err(ApiError::internal)?;
    check_storage_recovery(state)?;
    Ok(lock)
}

pub(super) fn check_storage_recovery(state: &ServerState) -> Result<(), ApiError> {
    if state.fs_guard.storage_recovery_required() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_recovery_pending",
            "Workspace storage recovery is pending",
        ));
    }
    Ok(())
}

pub(crate) fn is_document_path(path: &str) -> bool {
    path.ends_with(".md")
        && !path.ends_with(".outline.md")
        && path.split('/').all(|part| {
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.eq_ignore_ascii_case(".git")
                && !part.contains(['\\', ':'])
                && !part.chars().any(char::is_control)
        })
}

pub(crate) fn check_file_path(state: &ServerState, path: &str) -> Result<(), ApiError> {
    check_native_path(Path::new(&state.space_folder_path), path)
}

pub(super) fn check_native_path(root: &Path, path: &str) -> Result<(), ApiError> {
    let mut location = root.to_path_buf();
    for part in path.split('/') {
        location.push(part);
        match std::fs::symlink_metadata(&location) {
            Ok(meta) if meta.is_symlink() => return Err(ApiError::not_found()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(ApiError::internal(error)),
        }
    }
    Ok(())
}

pub(super) fn read_markdown(state: &ServerState, path: &str) -> Result<String, ApiError> {
    check_file_path(state, path)?;
    let meta = state.space.get_file_meta(path)?;
    if meta.size > MARKDOWN_LIMIT as i64 {
        return Err(too_large());
    }
    let (bytes, _) = state.space.read_file(path)?;
    if bytes.len() > MARKDOWN_LIMIT {
        return Err(too_large());
    }
    String::from_utf8(bytes).map_err(|_| ApiError::invalid("Markdown file is not UTF-8"))
}

pub(super) fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "document_too_large",
        "Markdown exceeds the size limit",
    )
}

fn save_locked(
    state: &ServerState,
    path: &str,
    markdown: String,
    expected: Option<&str>,
    actor: Actor,
) -> Result<(String, String), ApiError> {
    if markdown.len() > MARKDOWN_LIMIT {
        return Err(too_large());
    }
    check_file_path(state, path)?;
    let current = match state.space.get_file_meta(path) {
        Ok(_) if expected.is_none() => return Err(ApiError::conflict(None)),
        Ok(_) => Some(sha256_hex(read_markdown(state, path)?.as_bytes())),
        Err(SpaceError::NotFound) => None,
        Err(error) => return Err(error.into()),
    };
    if current.as_deref() != expected {
        return Err(ApiError::conflict(current));
    }
    let revision = sha256_hex(markdown.as_bytes());
    if current.as_ref() != Some(&revision) {
        let file = state.space.write_file(path, markdown.as_bytes(), None)?;
        if let Some(engine) = &state.revisions {
            engine.mark_account_write(path, &actor);
        }
        note_file_write(state, path, &revision, actor, &file);
    }
    Ok((markdown, revision))
}

pub(super) fn note_file_write(
    state: &ServerState,
    path: &str,
    revision: &str,
    actor: Actor,
    file: &FileMeta,
) {
    state.fs_guard.record(path, file, revision.to_owned());
    state.fs_guard.record_expected_write_with_meta(
        path,
        revision,
        actor,
        None,
        Some("librarian".into()),
        file.size,
        file.last_modified,
    );
}

fn summary(
    state: &ServerState,
    workspace: &str,
    id: String,
    path: String,
    title: Option<String>,
) -> DocumentSummary {
    let stem = path.strip_suffix(".md").unwrap_or(&path);
    let sidecar = outline_path(&path);
    DocumentSummary {
        title: title.unwrap_or_else(|| stem.rsplit('/').next().unwrap_or(stem).to_owned()),
        outline_enabled: check_file_path(state, &sidecar).is_ok()
            && state.space.get_file_meta(&sidecar).is_ok(),
        id,
        workspace_id: workspace.to_owned(),
        path,
    }
}

pub(super) fn outline_path(path: &str) -> String {
    format!("{}.outline.md", path.strip_suffix(".md").unwrap_or(path))
}

pub(super) fn title_from_front_matter(bytes: &[u8]) -> Option<String> {
    let prefix = &bytes[..bytes.len().min(METADATA_LIMIT)];
    let prefix = prefix.strip_prefix(b"\xef\xbb\xbf").unwrap_or(prefix);
    let mut lines = prefix.split_inclusive(|&byte| byte == b'\n');
    let opening = lines.next()?;
    if !is_front_matter_delimiter(opening) {
        return None;
    }
    let mut end = opening.len();
    for line in lines {
        if is_front_matter_delimiter(line) {
            let data: serde_yaml::Value =
                serde_yaml::from_slice(&prefix[opening.len()..end]).ok()?;
            return data
                .get("title")?
                .as_str()
                .filter(|title| !title.trim().is_empty())
                .map(str::to_owned);
        }
        end += line.len();
    }
    None
}

fn is_front_matter_delimiter(line: &[u8]) -> bool {
    matches!(line, b"---" | b"---\n" | b"---\r\n")
}

#[derive(Deserialize)]
pub(super) struct DocumentList {
    pub after: Option<String>,
    pub limit: Option<usize>,
}

pub(crate) fn routes(service: Arc<DocumentService>) -> Router {
    Router::new()
        .route("/workspaces", get(workspaces))
        .route("/workspaces/{workspace}/documents", get(list).post(create))
        .route("/workspaces/{workspace}/search", get(super::search::search))
        .route("/documents/{document}", get(document).put(edit))
        .route(
            "/documents/{document}/references",
            get(super::references::get_references),
        )
        .route(
            "/documents/{document}/outline",
            get(outline).put(save_outline),
        )
        .route(
            "/documents/{document}/revisions",
            get(super::revisions::history),
        )
        .route(
            "/documents/{document}/revisions/{commit}/diff",
            get(super::revisions::diff),
        )
        .route(
            "/documents/{document}/restore",
            post(super::revisions::restore),
        )
        .route(
            "/settings/devices/{device}",
            get(super::settings::get_preferences).put(super::settings::save_preferences),
        )
        .merge(super::ai::routes())
        .merge(super::ai_settings::routes())
        .merge(super::accounts::routes())
        .merge(super::ai_configuration::routes())
        .merge(super::ai_probes::routes())
        .merge(super::workspace::routes())
        .merge(super::ai_materials::routes())
        .merge(super::delivery::routes())
        .merge(super::imports::routes())
        .merge(super::snapshots::routes())
        .merge(super::session::routes())
        .merge(super::publication::routes())
        .merge(super::backup::routes())
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::map_response(|mut response: Response| async {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }))
        .with_state(service)
}

pub(crate) async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(ApiError::internal)?
}

pub(super) fn body<T>(request: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    request.map(|Json(body)| body).map_err(|error| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            too_large()
        } else {
            ApiError::invalid("Expected a valid JSON request")
        }
    })
}

async fn workspaces(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<Vec<Workspace>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || service.workspaces(&account)).await.map(Json)
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    query: Result<Query<DocumentList>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Json<Vec<DocumentSummary>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid document list query"))?;
    run(move || service.list(&account, &workspace, query))
        .await
        .map(Json)
}

async fn document(
    State(service): State<Arc<DocumentService>>,
    RoutePath(document): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Json<DocumentSnapshot>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || service.get(&account, &document))
        .await
        .map(Json)
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    RoutePath(workspace): RoutePath<String>,
    headers: HeaderMap,
    request: Result<Json<CreateDocument>, JsonRejection>,
) -> Result<(StatusCode, Json<DocumentSnapshot>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    let document = run(move || service.create(&account, &workspace, request)).await?;
    Ok((StatusCode::CREATED, Json(document)))
}

async fn edit(
    State(service): State<Arc<DocumentService>>,
    RoutePath(document): RoutePath<String>,
    headers: HeaderMap,
    request: Result<Json<WriteMarkdown>, JsonRejection>,
) -> Result<Json<DocumentSnapshot>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    run(move || service.edit(&account, &document, request))
        .await
        .map(Json)
}

async fn outline(
    State(service): State<Arc<DocumentService>>,
    RoutePath(document): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Json<OutlineSnapshot>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || service.get_outline(&account, &document))
        .await
        .map(Json)
}

async fn save_outline(
    State(service): State<Arc<DocumentService>>,
    RoutePath(document): RoutePath<String>,
    headers: HeaderMap,
    request: Result<Json<WriteMarkdown>, JsonRejection>,
) -> Result<Json<OutlineSnapshot>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    run(move || service.save_outline(&account, &document, request))
        .await
        .map(Json)
}
