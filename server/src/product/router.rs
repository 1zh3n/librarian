use std::borrow::Cow;
use std::{path::Path as FilePath, sync::Arc, time::Duration};

use axum::extract::{OriginalUri, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::{Json, Router};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::json;

use crate::auth::Authenticator;
use crate::multi::access::signed_in_user;
use crate::multi::users::UserStore;

use super::mcp_bridge::McpBridge;

pub struct ProductAsset {
    pub bytes: Cow<'static, [u8]>,
    pub content_type: String,
}

#[derive(Clone)]
pub struct ShellAuth {
    pub authenticator: Arc<Authenticator>,
    pub users: Arc<UserStore>,
}

pub struct ProductState {
    pub version: &'static str,
    pub asset: fn(&str) -> Option<ProductAsset>,
    pub auth: Option<ShellAuth>,
}

pub fn build_product_router(state: Arc<ProductState>) -> Router {
    build(state, Router::new())
}

pub fn build_configured_product_router(
    state: Arc<ProductState>,
    root: &FilePath,
    spaces: super::space_adapter::NativeSpaces,
) -> Result<(Router, McpBridge), String> {
    build_configured_product_router_with_parser(state, root, spaces, None)
}

/// Embedders can supply the absolute path of the trusted Librarian executable.
pub fn build_configured_product_router_with_parser(
    state: Arc<ProductState>,
    root: &FilePath,
    spaces: super::space_adapter::NativeSpaces,
    parser: Option<&FilePath>,
) -> Result<(Router, McpBridge), String> {
    if parser.is_some_and(|path| !path.is_absolute()) {
        return Err("Material parser requires an absolute executable path".into());
    }
    let mut service = super::documents::DocumentService::open(root, spaces)?;
    service.material_parser = parser.map(FilePath::to_owned);
    let service = Arc::new(service);
    super::ai_materials::sweep(&service, true).map_err(|error| format!("{error:?}"))?;
    sweep(&service);
    let maintain = Arc::downgrade(&service);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(service) = maintain.upgrade() else {
                break;
            };
            if let Err(error) = tokio::task::spawn_blocking(move || {
                if let Err(error) = super::ai_materials::sweep(&service, false) {
                    tracing::warn!(?error, "Material maintenance deferred");
                }
                sweep(&service)
            })
            .await
            {
                tracing::warn!(%error, "Workspace maintenance did not complete");
            }
        }
    });
    let routes = super::documents::routes(service.clone());
    let reading = super::reading::routes(service.clone());
    Ok((build(state, routes).merge(reading), McpBridge::new(service)))
}

fn sweep(service: &super::documents::DocumentService) {
    if let Err(error) = super::workspace::sweep_due(service) {
        tracing::warn!(?error, "Expired Workspace maintenance deferred");
    }
    if let Err(error) = super::snapshots::sweep_due(service) {
        tracing::warn!(?error, "Reader snapshot maintenance deferred");
    }
}

/// Headers for the single-page app shell.
///
/// `style-src` keeps `'unsafe-inline'` because CodeMirror and React Aria inject
/// style elements at runtime; scripts stay restricted to same-origin bundles.
const SHELL_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'";
const SHELL_REFERRER_POLICY: &str = "no-referrer";
const SHELL_PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

fn build(state: Arc<ProductState>, routes: Router) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .fallback(api_not_found)
        .with_state(state.clone())
        .merge(routes);

    Router::new()
        .route("/", get(index))
        .route("/ai", get(index))
        .route("/accounts", get(index))
        .route("/workspaces/{workspace}", get(index))
        .route("/workspaces/{workspace}/ai", get(index))
        .route("/workspaces/{workspace}/manage", get(index))
        .route("/workspaces/{workspace}/documents/{document}", get(index))
        .route("/r/{snapshot}", get(index))
        .route("/sw.js", get(service_worker))
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

async fn index(
    State(state): State<Arc<ProductState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if protected_shell(uri.path()) {
        if let Some(auth) = &state.auth {
            if signed_in_user(&auth.authenticator, &auth.users, &headers).is_none() {
                let next = utf8_percent_encode(uri.path(), NON_ALPHANUMERIC).to_string();
                return Redirect::to(&format!("/.auth/librarian/login?next={next}"))
                    .into_response();
            }
        }
    }
    let Some(asset) = (state.asset)("index.html") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut body = asset.bytes.into_owned();
    if let Some(href) = static_reading_href(uri.path()) {
        let text = String::from_utf8_lossy(&body);
        if let Some(end) = text.rfind("</body>") {
            let mut html = String::with_capacity(text.len() + 256);
            html.push_str(&text[..end]);
            html.push_str(
                "<noscript><p>此阅读页需要 JavaScript。若使用低 JS 或墨水屏，请打开<a href=\"",
            );
            html.push_str(&href);
            html.push_str("\">静态阅读版</a>。</p></noscript>");
            html.push_str(&text[end..]);
            body = html.into_bytes();
        }
    }
    (
        [
            (header::CONTENT_TYPE, asset.content_type.as_str()),
            (header::CACHE_CONTROL, "no-cache"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, SHELL_CSP),
            (header::REFERRER_POLICY, SHELL_REFERRER_POLICY),
            (header::X_FRAME_OPTIONS, "DENY"),
            (
                header::HeaderName::from_static("permissions-policy"),
                SHELL_PERMISSIONS_POLICY,
            ),
            (
                header::HeaderName::from_static("cross-origin-resource-policy"),
                "same-origin",
            ),
        ],
        body,
    )
        .into_response()
}

fn protected_shell(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path.is_empty() || path == "/ai" || path == "/accounts" || path.starts_with("/workspaces/")
}

fn static_reading_href(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    let segments = path.split('/').skip(1).collect::<Vec<_>>();
    let safe = |value: &str| {
        !value.is_empty()
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_-%.".contains(character))
    };
    match segments.as_slice() {
        ["r", snapshot] if safe(snapshot) => Some(format!("/r/{snapshot}/read")),
        ["workspaces", workspace, "documents", document] if safe(workspace) && safe(document) => {
            Some(format!("/workspaces/{workspace}/documents/{document}/read"))
        }
        _ => None,
    }
}

async fn service_worker(State(state): State<Arc<ProductState>>) -> Response {
    serve(&state, "sw.js", "no-cache")
}

async fn asset(State(state): State<Arc<ProductState>>, Path(name): Path<String>) -> Response {
    if name.contains(['/', '\\']) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let cache = if name == "reader-shell.json" || name == "static-reading.css" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    serve(&state, &format!("assets/{name}"), cache)
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
