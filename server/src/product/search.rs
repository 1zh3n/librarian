use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use silverbullet_server_search::{limits, QueryMode, QueryRequest, SearchError};

use crate::handlers::search::run_query;

use super::{
    auth::Account,
    contract::{ApiError, DocumentSummary},
    documents::{check_file_path, is_document_path, run, state, DocumentService},
};

const MAX_QUERY_CHARS: usize = 256;
const RESULT_LIMIT: usize = 20;

#[derive(Deserialize)]
pub(super) struct SearchQuery {
    q: String,
}

#[derive(Serialize)]
pub(super) struct SearchHit {
    document: DocumentSummary,
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
    let q = query.q.trim();
    if q.is_empty() || q.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::invalid(
            "Search query must be between 1 and 256 characters",
        ));
    }
    let requested_workspace = workspace.clone();
    let lookup = service.clone();
    let (instance, actor) =
        run(move || lookup.scope(&account, &requested_workspace, false)).await?;
    let mode = QueryMode::Words;
    let request = QueryRequest {
        query: q.to_owned(),
        mode: Some(mode),
        limit: Some(limits::MAX_RESULTS),
        ..QueryRequest::default()
    };
    let Json(result) = run_query(state(&instance)?, &actor, &headers, request, mode)
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
        let state = state(&instance)?;
        let _mutation = state.fs_guard.mutation.read().map_err(ApiError::internal)?;
        let mut seen = HashSet::new();
        let mut hits = Vec::new();
        for hit in result.items {
            let path = format!("{}.md", hit.page);
            if !is_document_path(&path)
                || !seen.insert(hit.page)
                || check_file_path(state, &path).is_err()
            {
                continue;
            }
            let Ok(meta) = state.space.get_file_meta(&path) else {
                continue;
            };
            hits.push(SearchHit {
                document: service.summary_from_meta(state, &workspace, path, meta.size)?,
                excerpt: hit.excerpt,
            });
            if hits.len() == RESULT_LIMIT {
                break;
            }
        }
        Ok(Json(hits))
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
