use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;

use crate::auth::{
    browser_sessions::logout_allowed, cookie::set_cookie_value, cookie_value, is_secure_request,
    request_host, request_origin, scoped_auth_cookie_name, CookieOptions,
};
use crate::multi::access::signed_in_user;

use super::{accounts, audit, contract::ApiError, documents::DocumentService};

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/session", get(identity))
        .route("/session/logout", post(logout))
        .route("/session/sessions", get(list_sessions))
        .route("/session/sessions/revoke-others", post(revoke_others))
        .route("/session/sessions/{session}", delete(revoke_session))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    id: String,
    provider: Option<String>,
    created_at: u64,
    expires_at: u64,
    shared: bool,
    current: bool,
}

#[derive(Serialize)]
struct SessionList {
    sessions: Vec<SessionView>,
}

#[derive(Serialize)]
struct RevokedSessions {
    revoked: usize,
}

fn current_session_id(service: &DocumentService, headers: &HeaderMap) -> Option<String> {
    let name = scoped_auth_cookie_name(&request_host(headers), "");
    let token = cookie_value(headers, &name)?;
    service
        .spaces
        .authenticator
        .verify_browser_jwt(&token)
        .ok()?
        .session_id
}

async fn list_sessions(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<SessionList>, ApiError> {
    let account = accounts::browser(&service, &headers, false)?;
    let current = current_session_id(&service, &headers);
    let sessions = service
        .spaces
        .authenticator
        .browser_sessions()
        .ok_or_else(|| ApiError::internal("Browser session store is unavailable"))?
        .list(account.username())
        .map_err(ApiError::internal)?;
    Ok(Json(SessionList {
        sessions: sessions
            .into_iter()
            .map(|session| SessionView {
                current: current.as_deref() == Some(session.id.as_str()),
                id: session.id,
                provider: session.provider,
                created_at: session.created_at,
                expires_at: session.expires_at,
                shared: session.shared,
            })
            .collect(),
    }))
}

async fn revoke_session(
    State(service): State<Arc<DocumentService>>,
    Path(session): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let account = accounts::browser(&service, &headers, true)?;
    if current_session_id(&service, &headers).as_deref() == Some(session.as_str()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "current_session",
            "Sign out to end the current session",
        ));
    }
    let revoked = service
        .spaces
        .authenticator
        .browser_sessions()
        .ok_or_else(|| ApiError::internal("Browser session store is unavailable"))?
        .revoke_for_user(&session, account.username())
        .map_err(ApiError::internal)?;
    if !revoked {
        return Err(ApiError::not_found());
    }
    audit::record(
        &service.metadata,
        audit::Event {
            actor: Some(account.username()),
            workspace: None,
            action: "account.session.revoke",
            target: Some("browser"),
            result: "ok",
            rule_id: None,
            request_id: None,
            metadata: None,
        },
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_others(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<RevokedSessions>, ApiError> {
    let account = accounts::browser(&service, &headers, true)?;
    let current = current_session_id(&service, &headers)
        .ok_or_else(|| ApiError::internal("Current browser session is unavailable"))?;
    let revoked = service
        .spaces
        .authenticator
        .browser_sessions()
        .ok_or_else(|| ApiError::internal("Browser session store is unavailable"))?
        .revoke_others(account.username(), &current)
        .map_err(ApiError::internal)?;
    let metadata = json!({ "revoked": revoked });
    audit::record(
        &service.metadata,
        audit::Event {
            actor: Some(account.username()),
            workspace: None,
            action: "account.session.revoke_others",
            target: Some("browser"),
            result: "ok",
            rule_id: None,
            request_id: None,
            metadata: Some(&metadata),
        },
    )?;
    Ok(Json(RevokedSessions { revoked }))
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
