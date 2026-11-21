use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;

use crate::auth::{
    browser_sessions::logout_allowed, cookie::set_cookie_value, cookie_value, is_secure_request,
    request_host, request_origin, scoped_auth_cookie_name, CookieOptions,
};
use crate::multi::access::signed_in_user;

use super::{contract::ApiError, documents::DocumentService};

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/session", get(identity))
        .route("/session/logout", post(logout))
}

async fn identity(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let spaces = &service.spaces;
    let unauthorized = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Sign in to continue",
        )
    };
    let username =
        signed_in_user(&spaces.authenticator, &spaces.users, &headers).ok_or_else(unauthorized)?;
    let version = spaces
        .users
        .credential_version(&username)
        .ok_or_else(unauthorized)?;
    let cache_id = sha256_hex(format!("librarian-offline-v1\0{username}\0{version}").as_bytes());
    Ok(Json(json!({
        "isAdmin": spaces.users.is_admin(&username),
        "username": username,
        "cacheId": cache_id,
    })))
}

async fn logout(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin != Some(request_origin(&headers).as_str()) || !logout_allowed(&headers) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "origin_mismatch",
            "Sign out must come from this origin",
        ));
    }
    let name = scoped_auth_cookie_name(&request_host(&headers), "");
    if let Some(token) = cookie_value(&headers, &name) {
        super::documents::run(move || {
            service
                .spaces
                .authenticator
                .revoke_browser_jwt(&token)
                .map_err(ApiError::internal)
        })
        .await?;
    }
    let cookie = set_cookie_value(
        &name,
        "",
        &CookieOptions {
            path: "/".into(),
            max_age_secs: Some(0),
            http_only: true,
            secure: is_secure_request(&headers),
            same_site: "Lax",
        },
    );
    let cookie = HeaderValue::from_str(&cookie).map_err(ApiError::internal)?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}
