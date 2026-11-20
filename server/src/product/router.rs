use std::borrow::Cow;
use std::{path::Path as FilePath, sync::Arc};

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

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
) -> Result<Router, String> {
    let service = super::documents::DocumentService::open(root, spaces)?;
    Ok(build(state, super::documents::routes(Arc::new(service))))
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
        .route("/workspaces/{workspace}/documents/{document}", get(index))
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
