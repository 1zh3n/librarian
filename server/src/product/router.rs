use std::borrow::Cow;
use std::{path::Path as FilePath, sync::Arc, time::Duration};

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use super::mcp_bridge::McpBridge;

pub struct ProductAsset {
    pub bytes: Cow<'static, [u8]>,
    pub content_type: String,
}

pub struct ProductState {
    pub version: &'static str,
    pub asset: fn(&str) -> Option<ProductAsset>,
}

pub fn build_product_router(state: Arc<ProductState>) -> Router {
    build(state, Router::new())
}

pub fn build_configured_product_router(
    state: Arc<ProductState>,
    root: &FilePath,
    spaces: super::space_adapter::NativeSpaces,
) -> Result<(Router, McpBridge), String> {
    let service = Arc::new(super::documents::DocumentService::open(root, spaces)?);
    sweep(&service);
    let maintain = Arc::downgrade(&service);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(service) = maintain.upgrade() else {
                break;
            };
            if let Err(error) = tokio::task::spawn_blocking(move || sweep(&service)).await {
                tracing::warn!(%error, "Workspace maintenance did not complete");
            }
        }
    });
    let routes = super::documents::routes(service.clone());
    Ok((build(state, routes), McpBridge::new(service)))
}

fn sweep(service: &super::documents::DocumentService) {
    if let Err(error) = super::workspace::sweep_due(service) {
        tracing::warn!(?error, "Expired Workspace maintenance deferred");
    }
    if let Err(error) = super::snapshots::sweep_due(service) {
        tracing::warn!(?error, "Reader snapshot maintenance deferred");
    }
}

fn build(state: Arc<ProductState>, routes: Router) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .fallback(api_not_found)
        .with_state(state.clone())
        .merge(routes);

    Router::new()
        .route("/", get(index))
        .route("/workspaces/{workspace}", get(index))
        .route("/workspaces/{workspace}/ai", get(index))
        .route("/workspaces/{workspace}/manage", get(index))
        .route("/workspaces/{workspace}/documents/{document}", get(index))
        .route("/r/{snapshot}", get(index))
        .route("/assets/{name}", get(asset))
        .with_state(state)
        .nest("/api/v1", api)
}

async fn health(State(state): State<Arc<ProductState>>) -> impl IntoResponse {
    Json(json!({ "status": "ok", "version": state.version }))
}

async fn api_not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "code": "not_found", "message": "API route not found" })),
    )
}

async fn index(State(state): State<Arc<ProductState>>) -> Response {
    serve(&state, "index.html", "no-cache")
}

async fn asset(State(state): State<Arc<ProductState>>, Path(name): Path<String>) -> Response {
    if name.contains(['/', '\\']) {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve(
        &state,
        &format!("assets/{name}"),
        "public, max-age=31536000, immutable",
    )
}

fn serve(state: &ProductState, path: &str, cache: &'static str) -> Response {
    let Some(asset) = (state.asset)(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, asset.content_type.as_str()),
            (header::CACHE_CONTROL, cache),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        asset.bytes,
    )
        .into_response()
}
