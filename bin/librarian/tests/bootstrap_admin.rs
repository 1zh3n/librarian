use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::{
    auth::totp, multi::users::UserStore, product::space_adapter::create_admin_invite,
};
use tower::ServiceExt;

const HOST: &str = "127.0.0.1:6947";
const ORIGIN: &str = "http://127.0.0.1:6947";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

async fn send(app: &Router, method: &str, path: &str, input: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HOST)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(input.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 65536).await.unwrap();
    (
        parts.status,
        serde_json::from_slice(&bytes).unwrap_or_default(),
    )
}

#[tokio::test]
async fn bootstrap_admin_invite_creates_a_totp_admin_once() {
    let root = tempfile::tempdir().unwrap();
    let invite = create_admin_invite(
        root.path(),
        "bootstrap-admin",
        Some("https://example.test"),
        3600,
        true,
    )
    .unwrap();
    assert!(invite
        .url
        .starts_with("https://example.test/.auth/librarian/invite?token="));

    let app = librarian::Product::open(root.path(), 0).unwrap().router();
    let preview_path = format!("/api/v1/invites/{}", invite.token);
    let (status, preview) = send(&app, "GET", &preview_path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["username"], "bootstrap-admin");
    assert_eq!(preview["admin"], true);
    assert_eq!(preview["workspaces"].as_array().unwrap().len(), 0);

    let secret = totp::generate_secret();
    let body = json!({
        "password":"bootstrap-admin-password-2026",
        "totpSecret": secret,
        "code": totp::current_code(&secret, now()).unwrap()
    });
    let (status, accepted) = send(
        &app,
        "POST",
        &format!("/api/v1/invites/{}/accept", invite.token),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["recoveryCodes"].as_array().unwrap().len(), 10);

    let users = UserStore::open(root.path()).unwrap().unwrap();
    assert!(users.is_admin("bootstrap-admin"));
    assert!(users.totp_enabled("bootstrap-admin"));

    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/v1/invites/{}/accept", invite.token),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
