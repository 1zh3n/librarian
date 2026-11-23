use std::{
    collections::BTreeSet,
    io,
    path::{Path, PathBuf},
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
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
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
    pub(super) material_parser: Option<PathBuf>,
}

impl DocumentService {
    pub(crate) fn open(root: &Path, spaces: NativeSpaces) -> Result<Self, String> {
        let metadata = Metadata::open(root)?;
        let service = Self {
            reader_links: super::reader_links::ReaderLinks::load(&metadata)?,
            ai_discovery: super::ai_settings::AiDiscoveryService::open(&metadata)?,
            material_parser: None,
            metadata,
            spaces,
        };
        super::file_actions::storage::recover(&service)
            .map_err(|error| format!("Could not recover workspace file actions: {error:?}"))?;
        Ok(service)
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
        self.workspaces_under_guard(account)
    }

    pub(super) fn workspaces_under_guard(
        &self,
        account: &Account,
    ) -> Result<Vec<Workspace>, ApiError> {
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
        let file_names = files
            .iter()
            .map(|file| file.name.clone())
            .collect::<BTreeSet<_>>();
        let files = files
            .into_iter()
            .filter(|file| is_document_path(&file.name))
            .filter(|file| query.after.as_ref().is_none_or(|after| file.name > *after))
            .filter(|file| check_file_path(state, &file.name).is_ok())
            .take(query.limit.unwrap_or(100))
            .collect::<Vec<_>>();
        let paths = files
            .iter()
            .map(|file| file.name.clone())
            .collect::<Vec<_>>();
        let ids = self.metadata.document_ids(workspace, &paths)?;
        files
            .into_iter()
            .map(|file| {
                let id = ids
                    .get(&file.name)
                    .cloned()
                    .ok_or_else(|| ApiError::internal("missing document id"))?;
                // File navigation shows the file name. Content titles are resolved by
                // the document/snapshot paths; listing must not read every file prefix.
                let title = file.name.rsplit('/').next().map(str::to_owned);
                Ok(summary_with_outline(
                    workspace,
                    id,
                    file.name.clone(),
                    title,
                    file_names.contains(&outline_path(&file.name)),
                ))
            })
            .collect()
    }

    pub(super) fn summary_from_markdown(
        &self,
        state: &ServerState,
        workspace: &str,
        path: String,
        markdown: &str,
    ) -> Result<DocumentSummary, ApiError> {
        let id = self.metadata.document_id(workspace, &path)?;
        let title = title_from_markdown(markdown.as_bytes());
        Ok(summary(state, workspace, id, path, title))
    }

    /// Summaries for search results: file navigation uses the file name, so
    /// search must not parse a content title or upsert an id per hit.
    pub(super) fn summaries_for_search(
        &self,
        state: &ServerState,
        workspace: &str,
        paths: &[String],
    ) -> Result<Vec<DocumentSummary>, ApiError> {
        let ids = self.metadata.document_ids(workspace, paths)?;
        let file_names = state
            .space
            .fetch_file_list()?
            .into_iter()
            .map(|file| file.name)
            .collect::<BTreeSet<_>>();
        paths
            .iter()
            .map(|path| {
                let id = ids
                    .get(path)
                    .cloned()
                    .ok_or_else(|| ApiError::internal("missing document id"))?;
                let title = path.rsplit('/').next().map(str::to_owned);
                Ok(summary_with_outline(
                    workspace,
                    id,
                    path.clone(),
                    title,
                    file_names.contains(&outline_path(path)),
                ))
            })
            .collect()
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
        let title = title_from_markdown(markdown.as_bytes());
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
        self.get_in(account, &workspace, id)
    }

    pub(super) fn get_in(
        &self,
        account: &Account,
        workspace: &str,
        id: &str,
    ) -> Result<DocumentSnapshot, ApiError> {
        let (instance, _) = self.scope(account, workspace, false)?;
        let state = state(&instance)?;
        let _mutation = product_read(state)?;
        let path = self.path_in(workspace, id)?;
        let markdown = read_markdown(state, &path)?;
        let revision = sha256_hex(markdown.as_bytes());
        Ok(self.snapshot(state, workspace, id.to_owned(), path, markdown, revision))
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
        self.get_outline_in(account, &workspace, id)
    }

    pub(super) fn get_outline_in(
        &self,
        account: &Account,
        workspace: &str,
        id: &str,
    ) -> Result<OutlineSnapshot, ApiError> {
        let (instance, _) = self.scope(account, workspace, false)?;
        let state = state(&instance)?;
        let _mutation = product_read(state)?;
        let path = self.path_in(workspace, id)?;
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
    if native_path_has_no_links(root, path).map_err(ApiError::internal)? {
        Ok(())
    } else {
        Err(ApiError::not_found())
    }
}

pub(super) fn native_path_has_no_links(root: &Path, path: &str) -> io::Result<bool> {
    let mut location = root.to_path_buf();
    for part in path.split('/') {
        location.push(part);
        match std::fs::symlink_metadata(&location) {
            Ok(meta) if meta.is_symlink() => return Ok(false),
            Ok(_) => {}
            // Once a component is absent or is a regular file, there are no more
            // descendants to check for links. The caller handles path occupancy.
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                break
            }

            Err(error) => return Err(error),
        }
    }
    Ok(true)
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
    let mut old_size = 0i64;
    let current = match state.space.get_file_meta(path) {
        Ok(_) if expected.is_none() => return Err(ApiError::conflict(None)),
        Ok(meta) => {
            old_size = meta.size;
            Some(sha256_hex(read_markdown(state, path)?.as_bytes()))
        }
        Err(SpaceError::NotFound) => None,
        Err(error) => return Err(error.into()),
    };
    if current.as_deref() != expected {
        return Err(ApiError::conflict(current));
    }
    let revision = sha256_hex(markdown.as_bytes());
    if current.as_ref() != Some(&revision) {
        super::quota::check_and_charge(state, markdown.len() as i64 - old_size)?;
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
    let sidecar = outline_path(&path);
    let outline_enabled =
        check_file_path(state, &sidecar).is_ok() && state.space.get_file_meta(&sidecar).is_ok();
    summary_with_outline(workspace, id, path, title, outline_enabled)
}

fn summary_with_outline(
    workspace: &str,
    id: String,
    path: String,
    title: Option<String>,
    outline_enabled: bool,
) -> DocumentSummary {
    let stem = path.strip_suffix(".md").unwrap_or(&path);
    DocumentSummary {
        title: title.unwrap_or_else(|| stem.rsplit('/').next().unwrap_or(stem).to_owned()),
        outline_enabled,
        id,
        workspace_id: workspace.to_owned(),
        path,
    }
}

pub(super) fn outline_path(path: &str) -> String {
    format!("{}.outline.md", path.strip_suffix(".md").unwrap_or(path))
}

/// The document's display title: front matter first, then the first H1.
/// Callers fall back to the file name when this returns `None`.
pub(super) fn title_from_markdown(bytes: &[u8]) -> Option<String> {
    front_matter_title(bytes).or_else(|| first_h1_text(bytes))
}

fn front_matter_title(bytes: &[u8]) -> Option<String> {
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

fn first_h1_text(bytes: &[u8]) -> Option<String> {
    let prefix = &bytes[..bytes.len().min(METADATA_LIMIT)];
    let prefix = prefix.strip_prefix(b"\xef\xbb\xbf").unwrap_or(prefix);
    // The prefix can end in the middle of a multi-byte character. The H1 is
    // near the start, so replacing a split character at the boundary is safe.
    let markdown = String::from_utf8_lossy(prefix);
    let parser = Parser::new_ext(&markdown, Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    let mut in_h1 = false;
    let mut title = String::new();
    for event in parser {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => {
                in_h1 = true;
                title.clear();
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) if in_h1 => break,
            Event::Text(value) | Event::Code(value) if in_h1 => title.push_str(&value),
            Event::SoftBreak | Event::HardBreak if in_h1 => title.push(' '),
            _ => {}
        }
    }
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty()).then_some(title)
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
        .merge(super::file_actions::routes())
        .merge(super::ai_materials::routes())
        .merge(super::delivery::routes())
        .merge(super::assets::routes())
        .merge(super::imports::routes())
        .merge(super::snapshots::routes())
        .merge(super::session::routes())
        .merge(super::audit_api::routes())
        .merge(super::publication::routes())
        .merge(super::backup::routes())
        .merge(super::mcp_settings::routes())
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::map_response(|mut response: Response| async {
            // Default every product response to no-store, but let explicit
            // cache policies (for example image ETag revalidation) win.
            response
                .headers_mut()
                .entry(header::CACHE_CONTROL)
                .or_insert(HeaderValue::from_static("no-store"));
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

#[cfg(test)]
mod tests {
    use super::title_from_markdown;

    #[test]
    fn front_matter_title_wins_over_the_first_heading() {
        let markdown = b"---\ntitle: Front matter\n---\n\n# Body heading\n";
        assert_eq!(
            title_from_markdown(markdown).as_deref(),
            Some("Front matter")
        );
    }

    #[test]
    fn the_first_h1_is_the_title_without_front_matter() {
        let markdown = b"Intro\n\n# First *real* `title`\n\n## Later\n";
        assert_eq!(
            title_from_markdown(markdown).as_deref(),
            Some("First real title")
        );
    }

    #[test]
    fn h2_and_fenced_headings_are_ignored() {
        let markdown = b"```md\n# Not a title\n```\n\n## Only an h2\n\n# Real title\n";
        assert_eq!(title_from_markdown(markdown).as_deref(), Some("Real title"));
    }

    #[test]
    fn setext_h1_is_a_title() {
        assert_eq!(
            title_from_markdown(b"Setext title\n============\n").as_deref(),
            Some("Setext title")
        );
    }

    #[test]
    fn inline_markup_is_reduced_to_visible_text() {
        let markdown = b"# Hello <kbd>World</kbd> `code` [link](https://example.com)\n";
        assert_eq!(
            title_from_markdown(markdown).as_deref(),
            Some("Hello World code link")
        );
    }

    #[test]
    fn yaml_comments_are_not_headings() {
        let markdown = b"---\n# yaml comment\n---\n\n# Real title\n";
        assert_eq!(title_from_markdown(markdown).as_deref(), Some("Real title"));
    }

    #[test]
    fn empty_titles_fall_through_to_none() {
        assert_eq!(title_from_markdown(b"#\n\n# Later\n"), None);
        assert_eq!(title_from_markdown(b"## Only h2\n"), None);
        assert_eq!(title_from_markdown(b"no heading\n"), None);
    }

    #[test]
    fn chinese_h1_is_the_title() {
        let markdown = "# MCP 设置、图片与阅读模式评估\n\n2026-11-22 · 设计评估与实施建议\n";
        assert_eq!(
            title_from_markdown(markdown.as_bytes()).as_deref(),
            Some("MCP 设置、图片与阅读模式评估")
        );
    }

    #[test]
    fn a_split_utf8_at_the_prefix_boundary_does_not_hide_the_title() {
        let mut markdown = String::from("# Title\n");
        markdown.push_str(&"x".repeat(super::METADATA_LIMIT - markdown.len() - 1));
        markdown.push('中');
        assert_eq!(
            title_from_markdown(markdown.as_bytes()).as_deref(),
            Some("Title")
        );
    }

    #[test]
    fn bom_and_crlf_are_handled() {
        assert_eq!(
            title_from_markdown(b"\xef\xbb\xbf# Title\r\n").as_deref(),
            Some("Title")
        );
    }
}
