mod config;
mod render;
mod target_git;

use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    audit,
    auth::Account,
    content_policy::{self, Action},
    contract::ApiError,
    db::Metadata,
    documents::{body, product_read, run, state, DocumentService, MARKDOWN_LIMIT},
    revisions::validate_commit,
    security_levels::SecurityLevel,
    snapshots::{document_blob_at_commit, git_blobs},
    workspace::{self, require_manage},
};

static PUBLICATION_GATE: Mutex<()> = Mutex::new(());

pub(super) fn migrate(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute_batch(
        "CREATE TABLE zola_publications (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            plan TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'published')),
            prepared_commit TEXT,
            url TEXT,
            message TEXT
        );",
    )
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/publications/targets", get(targets))
        .route("/publications", get(list).post(create))
        .route("/publications/{publication}", get(read))
        .route("/publications/{publication}/confirm", post(confirm))
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PublicationRequest {
    pub(super) workspace_id: String,
    pub(super) target_id: String,
    pub(super) commit_id: String,
    pub(super) document_ids: Vec<String>,
    pub(super) operation_id: String,
    #[serde(default)]
    pub(super) confirm: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicationView {
    id: String,
    workspace_id: String,
    target_id: String,
    document_ids: Vec<String>,
    status: String,
    source_commit_id: String,
    published_commit_id: Option<String>,
    url: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Plan {
    request: PublicationRequest,
    target: config::Target,
    paths: Vec<String>,
}

struct Journal {
    plan: Plan,
    status: String,
    prepared_commit: Option<String>,
    url: Option<String>,
    message: Option<String>,
}

impl Journal {
    fn read(metadata: &Metadata, id: &str) -> Result<Option<Self>, ApiError> {
        let result = metadata.connection()?.query_row(
            "SELECT plan, status, prepared_commit, url, message FROM zola_publications WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        result
            .map(|(plan, status, prepared_commit, url, message)| {
                Ok(Self {
                    plan: serde_json::from_str(&plan).map_err(ApiError::internal)?,
                    status,
                    prepared_commit,
                    url,
                    message,
                })
            })
            .transpose()
    }

    fn view(self) -> PublicationView {
        PublicationView {
            id: self.plan.request.operation_id,
            workspace_id: self.plan.request.workspace_id,
            target_id: self.plan.request.target_id,
            document_ids: self.plan.request.document_ids,
            source_commit_id: self.plan.request.commit_id,
            published_commit_id: (self.status == "published")
                .then_some(self.prepared_commit)
                .flatten(),
            url: (self.status == "published").then_some(self.url).flatten(),
            status: self.status,
            message: self.message,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetsQuery {
    workspace_id: String,
}

#[derive(Serialize)]
struct Targets {
    targets: Vec<config::TargetSummary>,
}

async fn targets(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    query: Result<Query<TargetsQuery>, QueryRejection>,
) -> Result<Json<Targets>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("Expected a workspace ID"))?;
    run(move || {
        service.scope(&account, &query.workspace_id, false)?;
        Ok(Json(Targets {
            targets: config::list(&service.metadata, &query.workspace_id)?,
        }))
    })
    .await
}

#[derive(Serialize)]
struct PublicationList {
    publications: Vec<PublicationView>,
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    query: Result<Query<TargetsQuery>, QueryRejection>,
) -> Result<Json<PublicationList>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("Expected a workspace ID"))?;
    run(move || {
        service.scope(&account, &query.workspace_id, false)?;
        let ids = {
            let database = service.metadata.connection()?;
            let mut statement = database.prepare(
                "SELECT id FROM zola_publications WHERE workspace_id = ?1 ORDER BY rowid DESC LIMIT 50",
            )?;
            let rows = statement.query_map([&query.workspace_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let publications = ids.into_iter()
            .map(|id| Journal::read(&service.metadata, &id).map(|journal| journal.map(Journal::view)))
            .collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect();
        Ok(Json(PublicationList { publications }))
    }).await
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    request: Result<Json<PublicationRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<PublicationView>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let request = body(request)?;
    run(move || {
        let confirm = request.confirm;
        if confirm {
            require_manage(&service, &account, &request.workspace_id)?;
        }
        let _gate = PUBLICATION_GATE.lock().map_err(ApiError::internal)?;
        let id = request.operation_id.clone();
        let (created, journal) = propose(&service, &account, request)?;
        let status = if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        };
        let view = if confirm {
            execute(&service, &account, &id)?.view()
        } else {
            journal.view()
        };
        Ok((status, Json(view)))
    })
    .await
}

async fn read(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PublicationView>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        let journal = Journal::read(&service.metadata, &id)?.ok_or_else(ApiError::not_found)?;
        service.scope(&account, &journal.plan.request.workspace_id, false)?;
        Ok(Json(journal.view()))
    })
    .await
}

async fn confirm(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PublicationView>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || {
        let _gate = PUBLICATION_GATE.lock().map_err(ApiError::internal)?;
        Ok(Json(execute(&service, &account, &id)?.view()))
    })
    .await
}

pub(super) fn request_proposal(
    service: &DocumentService,
    account: &Account,
    request: PublicationRequest,
) -> Result<PublicationView, ApiError> {
    if request.confirm {
        return Err(ApiError::invalid(
            "Confirm publication through the Workspace management page",
        ));
    }
    let _gate = PUBLICATION_GATE.lock().map_err(ApiError::internal)?;
    propose(service, account, request).map(|(_, journal)| journal.view())
}

fn validate(request: &PublicationRequest) -> Result<(), ApiError> {
    if !Uuid::parse_str(&request.operation_id)
        .is_ok_and(|id| id.to_string() == request.operation_id)
    {
        return Err(ApiError::invalid("Expected a canonical operation UUID"));
    }
    if request.document_ids.is_empty()
        || request.document_ids.len() > 64
        || request.document_ids.iter().collect::<BTreeSet<_>>().len() != request.document_ids.len()
    {
        return Err(ApiError::invalid(
            "Choose between 1 and 64 distinct documents",
        ));
    }
    validate_commit(&request.commit_id)?;
    Ok(())
}

fn propose(
    service: &DocumentService,
    account: &Account,
    mut request: PublicationRequest,
) -> Result<(bool, Journal), ApiError> {
    validate(&request)?;
    request.confirm = false;
    request.commit_id.make_ascii_lowercase();
    let (instance, _) = service.scope(account, &request.workspace_id, true)?;
    if let Some(journal) = Journal::read(&service.metadata, &request.operation_id)? {
        if journal.plan.request != request {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "publication_operation_reused",
                "Operation ID was used for a different publication",
            ));
        }
        if journal.status != "published" {
            let state = state(&instance)?;
            let _read = product_read(state)?;
            let (_, repo) = git_blobs::repo(state)?;
            target_git::pin_source(&repo, &request.operation_id, &request.commit_id)
                .map_err(ApiError::internal)?;
        }
        return Ok((false, journal));
    }
    let target = config::get(&service.metadata, &request.workspace_id, &request.target_id)?;
    let state = state(&instance)?;
    let _read = product_read(state)?;
    let (store, repo) = git_blobs::repo(state)?;
    let commit = git_blobs::resolve_commit(&repo, &request.commit_id)?;
    let paths = request
        .document_ids
        .iter()
        .map(|id| {
            let path = service.path_in(&request.workspace_id, id)?;
            let lineage = super::revisions::restored::Lineage::load(
                &service.metadata,
                store,
                &request.workspace_id,
                id,
                &path,
            )?;
            document_blob_at_commit(store, &repo, &commit, &lineage).map(|(path, _)| path)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let id = request.operation_id.clone();
    let plan = Plan {
        request,
        target,
        paths,
    };
    service.metadata.connection()?.execute(
        "INSERT INTO zola_publications(id, workspace_id, plan, status) VALUES (?1, ?2, ?3, 'pending')",
        params![id, plan.request.workspace_id, serde_json::to_string(&plan).map_err(ApiError::internal)?],
    )?;
    target_git::pin_source(&repo, &id, &commit).map_err(ApiError::internal)?;
    Ok((
        true,
        Journal {
            plan,
            status: "pending".into(),
            prepared_commit: None,
            url: None,
            message: None,
        },
    ))
}

fn execute(service: &DocumentService, account: &Account, id: &str) -> Result<Journal, ApiError> {
    let journal = Journal::read(&service.metadata, id)?.ok_or_else(ApiError::not_found)?;
    let request = &journal.plan.request;
    let (instance, _) = require_manage(service, account, &request.workspace_id)?;
    if journal.status == "published" {
        return Ok(journal);
    }
    let details = workspace::info(&service.metadata, &request.workspace_id)?;
    if details.security_level != SecurityLevel::Public {
        audit::policy_block(
            &service.metadata,
            Some(account.username()),
            &request.workspace_id,
            "publication",
            "publication_requires_public_workspace",
        )?;
        return Err(ApiError::policy_blocked(
            "publication_requires_public_workspace",
        ));
    }
    {
        let state = state(&instance)?;
        let _read = product_read(state)?;
        let (store, repo) = git_blobs::repo(state)?;
        let commit = git_blobs::resolve_commit(&repo, &request.commit_id)?;
        if let Some(rule) = publication_block_rule(
            store,
            &repo,
            &commit,
            &journal.plan.paths,
            details.security_level,
        )? {
            audit::policy_block(
                &service.metadata,
                Some(account.username()),
                &request.workspace_id,
                "publication",
                rule,
            )?;
            return Err(ApiError::policy_blocked(rule));
        }
    }
    let configured = config::get(&service.metadata, &request.workspace_id, &request.target_id)?;
    if configured != journal.plan.target {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "publication_target_changed",
            "Publication target changed since the proposal; create a new proposal",
        ));
    }
    if let Some(commit) = &journal.prepared_commit {
        if target_git::contains(&configured, commit).map_err(ApiError::internal)? {
            mark_published(&service.metadata, id, commit, journal.url.as_deref())?;
            return Journal::read(&service.metadata, id)?.ok_or_else(ApiError::not_found);
        }
    }

    let rendered = {
        let state = state(&instance)?;
        let _read = product_read(state)?;
        let (store, repo) = git_blobs::repo(state)?;
        let commit = git_blobs::resolve_commit(&repo, &request.commit_id)?;
        render::prepare(store, &repo, &commit, &journal.plan)
    };
    let performed = rendered.and_then(|output| {
        let url = output.url.clone();
        let commit = target_git::publish(&configured, output, |commit| {
            require_manage(service, account, &request.workspace_id)
                .map_err(|_| "Publication permission changed")?;
            let current = config::get(&service.metadata, &request.workspace_id, &request.target_id)
                .map_err(|_| "Publication target changed")?;
            if current != configured {
                return Err("Publication target changed".into());
            }
            service
                .metadata
                .connection()
                .map_err(|_| "Publication journal is unavailable")?
                .execute(
                    "UPDATE zola_publications SET prepared_commit = ?2, url = ?3 WHERE id = ?1",
                    params![id, commit, url],
                )
                .map_err(|_| "Publication journal is unavailable")?;
            Ok(())
        })?;
        Ok((commit, url))
    });
    match performed {
        Ok((commit, url)) => mark_published(&service.metadata, id, &commit, url.as_deref())?,
        Err(message) => {
            service.metadata.connection()?.execute(
                "UPDATE zola_publications SET status = 'failed', message = ?2 WHERE id = ?1",
                params![id, message],
            )?;
        }
    }
    Journal::read(&service.metadata, id)?.ok_or_else(ApiError::not_found)
}

fn publication_block_rule(
    store: &crate::revisions::RevisionStore,
    repo: &std::path::Path,
    commit: &str,
    paths: &[String],
    level: SecurityLevel,
) -> Result<Option<&'static str>, ApiError> {
    for path in paths {
        let oid = git_blobs::find(store, repo, commit, path, MARKDOWN_LIMIT)?
            .ok_or_else(ApiError::not_found)?;
        let markdown = git_blobs::read(repo, &oid)?;
        let text = String::from_utf8_lossy(&markdown);
        let inspection = content_policy::inspect(&text, level);
        if inspection.action == Action::Deny {
            return Ok(Some(inspection.blocking_rule.unwrap_or("content_policy")));
        }
    }
    Ok(None)
}

fn mark_published(
    metadata: &Metadata,
    id: &str,
    commit: &str,
    url: Option<&str>,
) -> Result<(), ApiError> {
    metadata.connection()?.execute(
        "UPDATE zola_publications SET status = 'published', prepared_commit = ?2, url = ?3, message = NULL WHERE id = ?1",
        params![id, commit, url],
    )?;
    Ok(())
}
