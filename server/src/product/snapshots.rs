pub(super) mod git_blobs;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

use crate::{multi::instance::SpaceInstance, revisions::RevisionStore, state::ServerState};

use super::{
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::{
        body, check_file_path, check_storage_recovery, is_document_path, product_read,
        product_write, read_markdown, run, state, title_from_markdown, DocumentService,
        MARKDOWN_LIMIT,
    },
    mutations::{max_file_bytes, valid_file_path},
    revisions::restored::Lineage,
};
const MAX_DOCUMENTS: usize = 64;
const MAX_ATTACHMENTS: usize = 128;
const TITLE_PREFIX_LIMIT: usize = 32 * 1024;

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE reader_snapshots (
            key TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            expires_at INTEGER,
            commit_id TEXT,
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            manifest TEXT NOT NULL
        );
        CREATE INDEX reader_snapshots_workspace ON reader_snapshots(workspace_id, active, expires_at);",
    )
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route(
            "/workspaces/{workspace}/snapshots",
            get(list_snapshots).post(create),
        )
        .route("/snapshots/{snapshot}", get(read).delete(revoke))
        .route("/snapshots/{snapshot}/assets/{*path}", get(asset))
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Current,
    Release,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Audience {
    #[default]
    Members,
    Share,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSnapshot {
    kind: Kind,
    #[serde(default)]
    audience: Audience,
    document_ids: Vec<String>,
    #[serde(default)]
    attachment_paths: Vec<String>,
    expires_at: Option<i64>,
    commit_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    kind: Kind,
    audience: Audience,
    documents: Vec<ManifestDocument>,
    attachments: BTreeMap<String, Option<String>>,
}

#[derive(Serialize, Deserialize)]
struct ManifestDocument {
    id: String,
    release: Option<ReleaseDocument>,
}

#[derive(Serialize, Deserialize)]
struct ReleaseDocument {
    path: String,
    title: String,
    blob: String,
}

struct Snapshot {
    workspace: String,
    expires_at: Option<i64>,
    commit_id: Option<String>,
    manifest: Manifest,
}

#[derive(Serialize)]
struct ShareLink {
    id: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareLinkSummary {
    id: String,
    url: String,
    kind: Kind,
    audience: Audience,
    expires_at: Option<i64>,
    commit_id: Option<String>,
    document_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadQuery {
    document_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotView {
    id: String,
    workspace_id: String,
    kind: Kind,
    audience: Audience,
    expires_at: Option<i64>,
    commit_id: Option<String>,
    documents: Vec<SnapshotSummary>,
    document: SnapshotDocument,
    attachment_paths: Vec<String>,
}

#[derive(Clone, Serialize)]
struct SnapshotSummary {
    id: String,
    path: String,
    title: String,
}

#[derive(Serialize)]
struct SnapshotDocument {
    #[serde(flatten)]
    summary: SnapshotSummary,
    markdown: String,
    revision: String,
}

impl CreateSnapshot {
    fn validate(&self) -> Result<(), ApiError> {
        if self.document_ids.is_empty()
            || self.document_ids.len() > MAX_DOCUMENTS
            || self.document_ids.iter().collect::<BTreeSet<_>>().len() != self.document_ids.len()
        {
            return Err(ApiError::invalid(
                "Choose between 1 and 64 distinct documents",
            ));
        }
        if self.attachment_paths.len() > MAX_ATTACHMENTS
            || self.attachment_paths.iter().collect::<BTreeSet<_>>().len()
                != self.attachment_paths.len()
            || self
                .attachment_paths
                .iter()
                .any(|path| !valid_attachment(path))
        {
            return Err(ApiError::invalid(
                "Choose up to 128 distinct attachment paths",
            ));
        }
        if let Some(commit) = &self.commit_id {
            if matches!(self.kind, Kind::Current) {
                return Err(ApiError::invalid("Only releases can select a Git commit"));
            }
            super::revisions::validate_commit(commit)?;
        }
        if self.expires_at.is_some_and(|expiry| expiry <= now()) {
            return Err(ApiError::invalid("Snapshot expiry must be in the future"));
        }
        Ok(())
    }
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
    request: Result<Json<CreateSnapshot>, JsonRejection>,
) -> Result<(StatusCode, Json<ShareLink>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let mut request = body(request)?;
    request.validate()?;
    run(move || {
        let _workspace = service.metadata.workspace_guard()?;
        let (instance, _) = service.scope(&account, &workspace, true)?;
        let state = state(&instance)?;
        let capture = state.revisions.as_deref().filter(|engine| {
            matches!(request.kind, Kind::Release)
                && request.commit_id.is_none()
                && engine.store().auto_commit_allowed()
        });
        let link = if let Some(engine) = capture {
            engine.with_managed_write(|transaction| {
                check_storage_recovery(state)?;
                let (_, actor) = service.scope(&account, &workspace, true)?;
                active_workspace(&service.metadata, &workspace)?;
                let paths = resolve_paths(&service.metadata, &workspace, &request.document_ids)?;
                for path in &paths {
                    read_markdown(state, path)?;
                }
                for path in &request.attachment_paths {
                    asset_size(state, path)?;
                }
                let paths = paths
                    .into_iter()
                    .chain(request.attachment_paths.iter().cloned())
                    .collect::<Vec<_>>();
                request.commit_id = transaction
                    .checkpoint_files(&actor, &paths)
                    .map_err(ApiError::internal)?;
                create_locked(&service.metadata, state, &workspace, request)
            })
        } else {
            let _guard = product_write(state)?;
            service.scope(&account, &workspace, true)?;
            create_locked(&service.metadata, state, &workspace, request)
        }?;
        Ok((StatusCode::CREATED, Json(link)))
    })
    .await
}

async fn list_snapshots(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ShareLinkSummary>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let _workspace = service.metadata.workspace_guard()?;
        service.scope(&account, &workspace, true)?;
        active_workspace(&service.metadata, &workspace)?;
        let workspace_expiry = workspace_expiry(&service.metadata, &workspace)?;
        let connection = service.metadata.connection()?;
        let mut statement = connection.prepare(
            "SELECT key, expires_at, commit_id, manifest
             FROM reader_snapshots
             WHERE workspace_id = ?1 AND active = 1
             ORDER BY rowid DESC",
        )?;
        let rows = statement.query_map([&workspace], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut links = Vec::new();
        for row in rows {
            let (key, expires_at, commit_id, manifest) = row?;
            let manifest: Manifest = serde_json::from_str(&manifest).map_err(ApiError::internal)?;
            let expires_at = expires_at.into_iter().chain(workspace_expiry).min();
            if super::workspace::expired(expires_at) {
                continue;
            }
            links.push(ShareLinkSummary {
                url: format!("/r/{key}"),
                id: key,
                kind: manifest.kind,
                audience: manifest.audience,
                expires_at,
                commit_id,
                document_count: manifest.documents.len(),
            });
        }
        Ok(Json(links))
    })
    .await
}

fn create_locked(
    metadata: &Metadata,
    state: &ServerState,
    workspace: &str,
    request: CreateSnapshot,
) -> Result<ShareLink, ApiError> {
    active_workspace(metadata, workspace)?;
    request.validate()?;
    let paths = resolve_paths(metadata, workspace, &request.document_ids)?;
    let mut manifest = Manifest {
        kind: request.kind,
        audience: request.audience,
        documents: request
            .document_ids
            .into_iter()
            .map(|id| ManifestDocument { id, release: None })
            .collect(),
        attachments: request
            .attachment_paths
            .into_iter()
            .map(|path| (path, None))
            .collect(),
    };
    let id = Uuid::new_v4().simple().to_string();
    let key = sha256_hex(id.as_bytes());
    let commit = match request.kind {
        Kind::Current => {
            for path in &paths {
                read_markdown(state, path)?;
            }
            for path in manifest.attachments.keys() {
                asset_size(state, path)?;
            }
            None
        }
        Kind::Release => {
            let (store, repo) = git_blobs::repo(state)?;
            let commit =
                git_blobs::resolve_commit(&repo, request.commit_id.as_deref().unwrap_or("HEAD"))?;
            for (document, path) in manifest.documents.iter_mut().zip(paths) {
                let lineage = Lineage::load(metadata, store, workspace, &document.id, &path)?;
                document.release = Some(release_document(store, &repo, &commit, &lineage)?);
            }
            for (path, blob) in &mut manifest.attachments {
                let oid = git_blobs::find(store, &repo, &commit, path, max_file_bytes(path))?
                    .ok_or_else(ApiError::not_found)?;
                *blob = Some(oid);
            }
            Some((commit, repo))
        }
    };
    let serialized = serde_json::to_string(&manifest).map_err(ApiError::internal)?;
    metadata.connection()?.execute(
        "INSERT INTO reader_snapshots (key, workspace_id, expires_at, commit_id, active, manifest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            key,
            workspace,
            request.expires_at,
            commit.as_ref().map(|(oid, _)| oid),
            commit.is_none(),
            serialized
        ],
    )?;
    if let Some((commit, repo)) = commit {
        // Persist the inactive row first so interrupted creation can retire its pin.
        git_blobs::pin(&repo, &key, &commit)?;
        metadata.connection()?.execute(
            "UPDATE reader_snapshots SET active = 1 WHERE key = ?1",
            [&key],
        )?;
    }
    Ok(ShareLink {
        url: format!("/r/{id}"),
        id,
    })
}

fn resolve_paths(
    metadata: &Metadata,
    workspace: &str,
    ids: &[String],
) -> Result<Vec<String>, ApiError> {
    ids.iter()
        .map(|id| document_path(metadata, workspace, id))
        .collect()
}

fn document_path(metadata: &Metadata, workspace: &str, id: &str) -> Result<String, ApiError> {
    let (actual, path) = metadata.document_path(id)?;
    if actual != workspace || !is_document_path(&path) || !valid_file_path(&path) {
        return Err(ApiError::not_found());
    }
    Ok(path)
}

fn lookup(metadata: &Metadata, key: &str) -> Result<Snapshot, ApiError> {
    let (workspace, expires_at, commit_id, manifest): (String, Option<i64>, Option<String>, String) =
        metadata.connection()?.query_row(
            "SELECT workspace_id, expires_at, commit_id, manifest FROM reader_snapshots WHERE key = ?1 AND active = 1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .ok_or_else(ApiError::not_found)?;
    Ok(Snapshot {
        workspace,
        expires_at,
        commit_id,
        manifest: serde_json::from_str(&manifest).map_err(ApiError::internal)?,
    })
}

fn snapshot_key(id: &str) -> Result<String, ApiError> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(id.to_owned());
    }
    if id.len() != 32
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ApiError::not_found());
    }
    Ok(sha256_hex(id.as_bytes()))
}

fn workspace_instance(
    service: &DocumentService,
    workspace: &str,
) -> Result<Arc<SpaceInstance>, ApiError> {
    let space = service.metadata.space_id(workspace)?;
    service
        .spaces
        .manager
        .instance(&space)
        .ok_or_else(ApiError::not_found)
}

fn with_snapshot<T>(
    service: &DocumentService,
    headers: &HeaderMap,
    id: &str,
    read: impl FnOnce(Snapshot, &ServerState) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let key = snapshot_key(id)?;
    let initial = lookup(&service.metadata, &key)?;
    let instance = workspace_instance(service, &initial.workspace)?;
    let state = state(&instance)?;
    {
        let _guard = product_read(state)?;
        let mut snapshot = lookup(&service.metadata, &key)?;
        let workspace_expiry = workspace_expiry(&service.metadata, &snapshot.workspace)?;
        snapshot.expires_at = snapshot
            .expires_at
            .into_iter()
            .chain(workspace_expiry)
            .min();
        if !super::workspace::expired(snapshot.expires_at) {
            if matches!(snapshot.manifest.audience, Audience::Members) {
                let account = Account::authenticate(&service.spaces, headers, false)?;
                service.scope(&account, &snapshot.workspace, false)?;
            }
            return read(snapshot, state);
        }
    }
    let _workspace = service.metadata.workspace_guard()?;
    let instance = workspace_instance(service, &initial.workspace)?;
    let current_state = self::state(&instance)?;
    let _guard = product_write(current_state)?;
    if let Err(error) = retire_inactive(&service.metadata, current_state, &initial.workspace) {
        tracing::warn!(
            workspace = initial.workspace,
            ?error,
            "Reader snapshot retirement deferred"
        );
    }
    Err(ApiError::not_found())
}

async fn read(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    query: Result<Query<ReadQuery>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Json<SnapshotView>, ApiError> {
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid snapshot query"))?;
    run(move || {
        with_snapshot(&service, &headers, &id, |snapshot, state| {
            if query.document_id.as_ref().is_some_and(|id| {
                !snapshot
                    .manifest
                    .documents
                    .iter()
                    .any(|document| &document.id == id)
            }) {
                return Err(ApiError::not_found());
            }
            let mut selected = None;
            let mut summaries = Vec::new();
            for entry in &snapshot.manifest.documents {
                let is_selected = query
                    .document_id
                    .as_ref()
                    .map_or_else(|| selected.is_none(), |id| id == &entry.id);
                let result = read_entry(
                    &service.metadata,
                    state,
                    &snapshot.workspace,
                    entry,
                    is_selected,
                );
                let (summary, markdown) = match result {
                    Err(error)
                        if (!is_selected || query.document_id.is_none())
                            && error.status() == StatusCode::NOT_FOUND =>
                    {
                        continue
                    }
                    result => result?,
                };
                if let Some(markdown) = markdown {
                    selected = Some(SnapshotDocument {
                        summary: summary.clone(),
                        revision: sha256_hex(markdown.as_bytes()),
                        markdown,
                    });
                }
                summaries.push(summary);
            }
            Ok(Json(SnapshotView {
                id: id.clone(),
                workspace_id: snapshot.workspace,
                kind: snapshot.manifest.kind,
                audience: snapshot.manifest.audience,
                expires_at: snapshot.expires_at,
                commit_id: snapshot.commit_id,
                documents: summaries,
                document: selected.ok_or_else(ApiError::not_found)?,
                attachment_paths: snapshot.manifest.attachments.into_keys().collect(),
            }))
        })
    })
    .await
}

fn read_entry(
    metadata: &Metadata,
    state: &ServerState,
    workspace: &str,
    entry: &ManifestDocument,
    selected: bool,
) -> Result<(SnapshotSummary, Option<String>), ApiError> {
    let (path, title, markdown) = match &entry.release {
        Some(release) => {
            let markdown = if selected {
                let (_, repo) = git_blobs::repo(state)?;
                Some(release_markdown(&repo, &release.blob)?)
            } else {
                None
            };
            (release.path.clone(), release.title.clone(), markdown)
        }
        None => {
            let path = document_path(metadata, workspace, &entry.id)?;
            if selected {
                let markdown = read_markdown(state, &path)?;
                let title = title(&path, markdown.as_bytes());
                (path, title, Some(markdown))
            } else {
                check_file_path(state, &path)?;
                let meta = state.space.get_file_meta(&path)?;
                let size = usize::try_from(meta.size)
                    .unwrap_or(0)
                    .min(TITLE_PREFIX_LIMIT);
                let prefix = if size == 0 {
                    Vec::new()
                } else {
                    state.space.read_file_range(&path, 0, size)?.0
                };
                let title = title(&path, &prefix);
                (path, title, None)
            }
        }
    };
    Ok((
        SnapshotSummary {
            id: entry.id.clone(),
            path,
            title,
        },
        markdown,
    ))
}

fn release_markdown(repo: &std::path::Path, oid: &str) -> Result<String, ApiError> {
    String::from_utf8(git_blobs::read(repo, oid)?)
        .map_err(|_| ApiError::invalid("Version is not UTF-8 Markdown"))
}

pub(super) fn document_blob_at_commit(
    store: &RevisionStore,
    repo: &std::path::Path,
    commit: &str,
    lineage: &Lineage<'_>,
) -> Result<(String, String), ApiError> {
    let path = lineage
        .path_at(commit)?
        .filter(|path| is_document_path(path) && valid_file_path(path))
        .ok_or_else(ApiError::not_found)?;
    let blob = git_blobs::find(store, repo, commit, &path, MARKDOWN_LIMIT)?
        .ok_or_else(ApiError::not_found)?;
    Ok((path, blob))
}

fn release_document(
    store: &RevisionStore,
    repo: &std::path::Path,
    commit: &str,
    lineage: &Lineage<'_>,
) -> Result<ReleaseDocument, ApiError> {
    let (path, blob) = document_blob_at_commit(store, repo, commit, lineage)?;
    let markdown = release_markdown(repo, &blob)?;
    Ok(ReleaseDocument {
        title: title(&path, markdown.as_bytes()),
        path,
        blob,
    })
}

fn title(path: &str, bytes: &[u8]) -> String {
    title_from_markdown(bytes).unwrap_or_else(|| {
        let stem = path.strip_suffix(".md").unwrap_or(path);
        stem.rsplit('/').next().unwrap_or(stem).to_owned()
    })
}

async fn asset(
    State(service): State<Arc<DocumentService>>,
    Path((id, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    run(move || {
        with_snapshot(&service, &headers, &id, |snapshot, state| {
            if !valid_attachment(&path) {
                return Err(ApiError::not_found());
            }
            let blob = snapshot
                .manifest
                .attachments
                .get(&path)
                .ok_or_else(ApiError::not_found)?;
            let bytes = match blob {
                Some(blob) => {
                    let (_, repo) = git_blobs::repo(state)?;
                    git_blobs::read(&repo, blob)?
                }
                None => {
                    asset_size(state, &path)?;
                    state.space.read_file(&path)?.0
                }
            };
            if bytes.len() > max_file_bytes(&path) {
                return Err(too_large());
            }
            let mut response = super::delivery::binary_response(&path, bytes);
            response.headers_mut().insert(
                header::CONTENT_SECURITY_POLICY,
                header::HeaderValue::from_static("default-src 'none'; sandbox"),
            );
            Ok(response)
        })
    })
    .await
}

fn valid_attachment(path: &str) -> bool {
    valid_file_path(path) && !path.to_ascii_lowercase().ends_with(".md")
}

fn asset_size(state: &ServerState, path: &str) -> Result<(), ApiError> {
    check_file_path(state, path)?;
    if state.space.get_file_meta(path)?.size > max_file_bytes(path) as i64 {
        return Err(too_large());
    }
    Ok(())
}

fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "snapshot_file_too_large",
        "Snapshot file exceeds its size limit",
    )
}

async fn revoke(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || {
        let _workspace = service.metadata.workspace_guard()?;
        let key = snapshot_key(&id)?;
        let snapshot = lookup(&service.metadata, &key)?;
        let (instance, _) = service.scope(&account, &snapshot.workspace, true)?;
        let state = state(&instance)?;
        let _guard = product_write(state)?;
        service.scope(&account, &snapshot.workspace, true)?;
        let changed = service.metadata.connection()?.execute(
            "UPDATE reader_snapshots SET active = 0 WHERE key = ?1 AND active = 1",
            [&key],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found());
        }
        if let Err(error) = retire_inactive(&service.metadata, state, &snapshot.workspace) {
            tracing::warn!(
                workspace = snapshot.workspace,
                ?error,
                "Reader snapshot retirement deferred"
            );
        }
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn workspace_expiry(metadata: &Metadata, workspace: &str) -> Result<Option<i64>, ApiError> {
    Ok(super::workspace::info(metadata, workspace)?.expires_at)
}

fn active_workspace(metadata: &Metadata, workspace: &str) -> Result<(), ApiError> {
    if super::workspace::expired(workspace_expiry(metadata, workspace)?) {
        return Err(ApiError::not_found());
    }
    Ok(())
}

pub(super) fn sweep_due(service: &DocumentService) -> Result<(), ApiError> {
    let _workspace = service.metadata.workspace_guard()?;
    let workspaces = {
        let connection = service.metadata.connection()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT workspace_id FROM reader_snapshots WHERE active = 0 OR expires_at <= ?1",
        )?;
        let rows = statement.query_map([now()], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for workspace in workspaces {
        let result = (|| {
            let instance = workspace_instance(service, &workspace)?;
            let state = state(&instance)?;
            let _guard = product_write(state)?;
            retire_inactive(&service.metadata, state, &workspace)
        })();
        if let Err(error) = result {
            tracing::warn!(workspace, ?error, "Reader snapshot cleanup deferred");
        }
    }
    Ok(())
}

fn retire_inactive(
    metadata: &Metadata,
    state: &ServerState,
    workspace: &str,
) -> Result<(), ApiError> {
    retire(metadata, state, workspace, false)
}

pub(super) fn retire_workspace(
    metadata: &Metadata,
    state: &ServerState,
    workspace: &str,
) -> Result<(), ApiError> {
    retire(metadata, state, workspace, true)
}

fn retire(
    metadata: &Metadata,
    state: &ServerState,
    workspace: &str,
    entire_workspace: bool,
) -> Result<(), ApiError> {
    let retired = {
        let connection = metadata.connection()?;
        connection.execute(
            "UPDATE reader_snapshots SET active = 0 WHERE workspace_id = ?1 AND (?2 OR expires_at <= ?3)",
            params![workspace, entire_workspace, now()],
        )?;
        let mut statement = connection.prepare(
            "SELECT key, commit_id FROM reader_snapshots WHERE workspace_id = ?1 AND active = 0",
        )?;
        let rows = statement.query_map([workspace], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (key, commit) in retired {
        if commit.is_some() {
            let (_, repo) = git_blobs::repo(state)?;
            git_blobs::unpin(&repo, &key)?;
        }
        metadata
            .connection()?
            .execute("DELETE FROM reader_snapshots WHERE key = ?1", [key])?;
    }
    Ok(())
}
