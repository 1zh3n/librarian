use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use silverbullet_server_search::{limits, QueryMode, QueryRequest, SearchError};

use crate::handlers::search::run_query;

use super::{
    auth::Account,
    contract::{ApiError, DocumentSummary},
    documents::{is_document_path, product_read, read_markdown, run, state, DocumentService},
};

const MAX_QUERY_CHARS: usize = 256;
const RESULT_LIMIT: usize = 20;

#[derive(Deserialize)]
pub(super) struct SearchQuery {
    q: String,
}

#[derive(Serialize)]
pub(super) struct SearchHit {
    pub(super) document: DocumentSummary,
    excerpt: String,
}

pub(super) async fn search(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    query: Result<Query<SearchQuery>, QueryRejection>,
    headers: HeaderMap,
) -> Result<Json<Vec<SearchHit>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    let Query(query) = query.map_err(|_| ApiError::invalid("A search query is required"))?;
    find_documents(service, account, workspace, query.q, &headers)
        .await
        .map(Json)
}

pub(super) async fn find_documents(
    service: Arc<DocumentService>,
    account: Account,
    workspace: String,
    query: String,
    headers: &HeaderMap,
) -> Result<Vec<SearchHit>, ApiError> {
    let q = query.trim();
    if q.is_empty() || q.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::invalid(
            "Search query must be between 1 and 256 characters",
        ));
    }
    let requested_workspace = workspace.clone();
    let lookup = service.clone();
    let ((instance, actor), account) = run(move || {
        let scope = lookup.scope(&account, &requested_workspace, false)?;
        Ok((scope, account))
    })
    .await?;
    let mode = QueryMode::Words;
    let request = QueryRequest {
        query: q.to_owned(),
        mode: Some(mode),
        limit: Some(limits::MAX_RESULTS),
        ..QueryRequest::default()
    };
    let Json(result) = run_query(state(&instance)?, &actor, headers, request, mode)
        .await
        .map_err(|error| search_error(error.0))?;
    if result.partial && result.items.is_empty() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "index_building",
            "Search index is catching up",
        ));
    }
    run(move || {
        let (instance, _) = service.scope(&account, &workspace, false)?;
        let state = state(&instance)?;
        let _mutation = product_read(state)?;
        let mut seen = HashSet::new();
        let mut found = Vec::new();
        let mut paths = Vec::new();
        for hit in result.items {
            let path = format!("{}.md", hit.page);
            if !is_document_path(&path) || !seen.insert(hit.page) {
                continue;
            }
            let Ok(markdown) = read_markdown(state, &path) else {
                continue;
            };
            if hit.source_revision.as_deref() != Some(sha256_hex(markdown.as_bytes()).as_str()) {
                continue;
            }
            paths.push(path.clone());
            found.push((path, hit.excerpt));
            if found.len() == RESULT_LIMIT {
                break;
            }
        }
        let summaries = service.summaries_for_search(state, &workspace, &paths)?;
        Ok(summaries
            .into_iter()
            .zip(found)
            .map(|(document, (_, excerpt))| SearchHit { document, excerpt })
            .collect())
    })
    .await
}

fn search_error(error: SearchError) -> ApiError {
    let code = error.code();
    let (status, message) = match error {
        SearchError::Invalid(_) | SearchError::QueryTooShort(_) | SearchError::Unsupported(_) => {
            (StatusCode::UNPROCESSABLE_ENTITY, "Invalid search query")
        }
        SearchError::Busy => (StatusCode::TOO_MANY_REQUESTS, "Search is busy"),
        SearchError::Canceled => (StatusCode::CONFLICT, "Search was superseded"),
        SearchError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "Search is unavailable"),
        SearchError::Failed(_) => return ApiError::internal(error),
    };
    ApiError::new(status, code, message)
}
