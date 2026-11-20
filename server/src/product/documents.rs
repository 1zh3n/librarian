use std::{io, path::Path, sync::Arc};

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Path as RoutePath, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::Response,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use silverbullet_server_common::{revision::sha256_hex, RevisionsMode, SpaceError};

use crate::{auth::Actor, multi::instance::SpaceInstance, state::ServerState};

use super::{
    auth::Account,
    contract::{
        ApiError, CreateDocument, DocumentSnapshot, DocumentSummary, Workspace, WorkspaceDefaults,
        WriteMarkdown,
    },
    db::Metadata,
    space_adapter::NativeSpaces,
};

const MARKDOWN_LIMIT: usize = 4 * 1024 * 1024;
const METADATA_LIMIT: usize = 32 * 1024;

pub(crate) struct DocumentService {
    pub(crate) spaces: NativeSpaces,
    metadata: Metadata,
}

impl DocumentService {
    pub(crate) fn open(root: &Path, spaces: NativeSpaces) -> Result<Self, String> {
        Ok(Self {
            metadata: Metadata::open(root)?,
            spaces,
        })
    }

    fn scope(
        &self,
        account: &Account,
        workspace: &str,
        write: bool,
    ) -> Result<(Arc<SpaceInstance>, Actor), ApiError> {
        let space_id = self.metadata.space_id(workspace)?;
        let instance = self
            .spaces
            .manager
            .instance(&space_id)
            .ok_or_else(ApiError::not_found)?;
        let actor = account.actor(&self.spaces, &instance, write)?;
        Ok((instance, actor))
    }

    fn workspaces(&self, account: &Account) -> Result<Vec<Workspace>, ApiError> {
        let registry = self.spaces.manager.registry().current();
        let mut workspaces = Vec::new();
        for instance in registry.instances.values() {
            if account.actor(&self.spaces, instance, false).is_err() {
                continue;
            }
            let revision_mode = match instance
                .revisions
                .as_ref()
                .map(|engine| engine.store().mode())
            {
                Some(RevisionsMode::Managed) => "managed",
                Some(RevisionsMode::Unmanaged) => "repository",
                _ => "disabled",
            };
            workspaces.push(Workspace {
                id: self.metadata.workspace_id(&instance.id)?,
                space_id: instance.id.clone(),
                name: instance.config.name.clone(),
                origin: "native",
                retention: "persistent",
                revision_mode,
                defaults: WorkspaceDefaults {
                    outline_enabled: false,
                },
            });
        }
        workspaces.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
        Ok(workspaces)
    }

    fn list(
        &self,
        account: &Account,
        workspace: &str,
        query: DocumentList,
    ) -> Result<Vec<DocumentSummary>, ApiError> {
        let (instance, _) = self.scope(account, workspace, false)?;
        let state = state(&instance)?;
        let _mutation = state.fs_guard.mutation.read().map_err(ApiError::internal)?;
        let mut files = state.space.fetch_file_list()?;
        files.sort_unstable_by(|a, b| a.name.cmp(&b.name));

        files
            .into_iter()
            .filter(|file| is_document_path(&file.name))
            .filter(|file| query.after.as_ref().is_none_or(|after| file.name > *after))
            .filter(|file| check_file_path(state, &file.name).is_ok())
            .take(query.limit.unwrap_or(100))
            .map(|file| {
                let size = usize::try_from(file.size).unwrap_or(0).min(METADATA_LIMIT);
                let title = if size != 0 {
                    state
                        .space
                        .read_file_range(&file.name, 0, size)
                        .ok()
                        .and_then(|(prefix, _)| title_from_front_matter(&prefix))
                } else {
                    None
                };
                let id = self.metadata.document_id(workspace, &file.name)?;
                Ok(summary(state, workspace, id, file.name, title))
            })
            .collect()
    }

    fn get(&self, account: &Account, id: &str) -> Result<DocumentSnapshot, ApiError> {
        let (workspace, path) = self.metadata.document_path(id)?;
        let (instance, _) = self.scope(account, &workspace, false)?;
        let state = state(&instance)?;
        let _mutation = state.fs_guard.mutation.read().map_err(ApiError::internal)?;
        let markdown = read_markdown(state, &path)?;
        let revision = sha256_hex(markdown.as_bytes());
        Ok(snapshot(
            state,
            &workspace,
            id.to_owned(),
            path,
            markdown,
            revision,
        ))
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
        let (markdown, revision) = save(state, &path, request.content.markdown, None, actor)?;
        let id = self.metadata.document_id(workspace, &path)?;
        Ok(snapshot(state, workspace, id, path, markdown, revision))
    }

    fn edit(
        &self,
        account: &Account,
        id: &str,
        request: WriteMarkdown,
    ) -> Result<DocumentSnapshot, ApiError> {
        let (workspace, path) = self.metadata.document_path(id)?;
        let (instance, actor) = self.scope(account, &workspace, true)?;
        let expected = request
            .precondition()?
            .ok_or_else(|| ApiError::invalid("Saving requires a content revision"))?
            .to_owned();
        let state = state(&instance)?;
        let (markdown, revision) = save(state, &path, request.markdown, Some(&expected), actor)?;
        Ok(snapshot(
            state,
            &workspace,
            id.to_owned(),
            path,
            markdown,
            revision,
        ))
    }
}

fn state(instance: &SpaceInstance) -> Result<&ServerState, ApiError> {
    instance.state.as_deref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "space_unavailable",
            "Workspace is unavailable",
        )
    })
}

fn is_document_path(path: &str) -> bool {
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

fn check_file_path(state: &ServerState, path: &str) -> Result<(), ApiError> {
    let mut location = std::path::PathBuf::from(&state.space_folder_path);
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

fn read_markdown(state: &ServerState, path: &str) -> Result<String, ApiError> {
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

fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "document_too_large",
        "Markdown exceeds the size limit",
    )
}

fn save(
    state: &ServerState,
    path: &str,
    markdown: String,
    expected: Option<&str>,
    actor: Actor,
) -> Result<(String, String), ApiError> {
    if markdown.len() > MARKDOWN_LIMIT {
        return Err(too_large());
    }
    let _mutation = state
        .fs_guard
        .mutation
        .write()
        .map_err(ApiError::internal)?;
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
        state.fs_guard.record(path, &file, revision.clone());
        state.fs_guard.record_expected_write_with_meta(
            path,
            &revision,
            actor,
            None,
            Some("librarian".into()),
            file.size,
            file.last_modified,
        );
        if let Some(engine) = &state.revisions {
            engine.notify_file_saved();
        }
    }
    Ok((markdown, revision))
}

fn snapshot(
    state: &ServerState,
    workspace: &str,
    id: String,
    path: String,
    markdown: String,
    revision: String,
) -> DocumentSnapshot {
    let title = title_from_front_matter(markdown.as_bytes());
    DocumentSnapshot {
        document: summary(state, workspace, id, path, title),
        markdown,
        revision,
    }
}

fn summary(
    state: &ServerState,
    workspace: &str,
    id: String,
    path: String,
    title: Option<String>,
) -> DocumentSummary {
    let stem = path.strip_suffix(".md").unwrap_or(&path);
    let sidecar = format!("{stem}.outline.md");
    DocumentSummary {
        title: title.unwrap_or_else(|| stem.rsplit('/').next().unwrap_or(stem).to_owned()),
        outline_enabled: check_file_path(state, &sidecar).is_ok()
            && state.space.get_file_meta(&sidecar).is_ok(),
        id,
        workspace_id: workspace.to_owned(),
        path,
    }
}

fn title_from_front_matter(bytes: &[u8]) -> Option<String> {
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
struct DocumentList {
    after: Option<String>,
    limit: Option<usize>,
}

pub(crate) fn routes(service: Arc<DocumentService>) -> Router {
    Router::new()
        .route("/workspaces", get(workspaces))
        .route("/workspaces/{workspace}/documents", get(list).post(create))
        .route("/documents/{document}", get(document).put(edit))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::map_response(|mut response: Response| async {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }))
        .with_state(service)
}

async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(ApiError::internal)?
}

fn body<T>(request: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
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
    if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
        return Err(ApiError::invalid("limit must be between 1 and 500"));
    }
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
