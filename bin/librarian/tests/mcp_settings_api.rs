use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::{
    auth::mcp::grants::{ClientKind, GrantStore, NewGrant},
    multi::users::{Profile, UserStore},
};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:6947";
const HOST: &str = "127.0.0.1:6947";
const PASSWORD: &str = "test-account-only-password";

struct Fixture {
    _root: TempDir,
    app: Router,
    admin: String,
    member: String,
    other: String,
    member_grant: String,
    other_grant: String,
}

impl Fixture {
    async fn new(mcp: bool, public_reader_url: Option<&str>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for (name, admin) in [("admin", true), ("member", false), ("other", false)] {
            users
                .create_user(name, PASSWORD, admin, Profile::default())
                .unwrap();
        }
        let space = root.path().join("spaces/left");
        fs::create_dir_all(&space).unwrap();
        fs::write(space.join("Index.md"), "# Left\n").unwrap();
        fs::write(
            root.path().join("spaces.json"),
            json!({
                "left": {
                    "name": "Left",
                    "binding": {"prefix": "/left"},
                    "access": "none",
                    "members": {"member": {"role": "write"}, "other": {"role": "write"}},
                    "revisions": "managed"
                }
            })
            .to_string(),
        )
        .unwrap();
        if let Some(url) = public_reader_url {
            fs::create_dir_all(root.path().join(".librarian")).unwrap();
            fs::write(
                root.path().join(".librarian/server.json"),
                json!({"publicReaderUrl": url}).to_string(),
            )
            .unwrap();
        }
        fs::write(
            root.path().join("server.json"),
            json!({"primaryUrl": ORIGIN, "serverName": "Librarian", "mcp": mcp}).to_string(),
        )
        .unwrap();

        let grants = GrantStore::load(root.path()).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let member_grant = grants
            .create(
                NewGrant {
                    username: "member".into(),
                    client_id: "member-client".into(),
                    client_name: "Member app".into(),
                    client_kind: ClientKind::Dcr,
                    verified_host: None,
                    redirect_host: "127.0.0.1".into(),
                    resource: format!("{ORIGIN}/.mcp"),
                    spaces: vec!["left".into()],
                    scope: "mcp".into(),
                    access: "write".into(),
                    credential_version: None,
                },
                now,
            )
            .unwrap()
            .id;
        let other_grant = grants
            .create(
                NewGrant {
                    username: "other".into(),
                    client_id: "other-client".into(),
                    client_name: "Other app".into(),
                    client_kind: ClientKind::Cimd,
                    verified_host: Some("other.example.test".into()),
                    redirect_host: "other.example.test".into(),
                    resource: format!("{ORIGIN}/.mcp"),
                    spaces: vec!["left".into()],
                    scope: "mcp".into(),
                    access: "write".into(),
                    credential_version: None,
                },
                now,
            )
            .unwrap()
            .id;
        drop(grants);

        let app = librarian::Product::open(root.path(), 6947)
            .unwrap()
            .router();
        let fixture = Self {
            _root: root,
            app,
            admin: String::new(),
            member: String::new(),
            other: String::new(),
            member_grant,
            other_grant,
        };
        let admin = fixture.login("admin").await;
        let member = fixture.login("member").await;
        let other = fixture.login("other").await;
        Self {
            admin,
            member,
            other,
            ..fixture
        }
    }

    async fn login(&self, username: &str) -> String {
        let form = format!("username={username}&password={PASSWORD}");
        let response = self
            .app
            .clone()
            .oneshot(
                Request::post("/.auth/librarian/login")
                    .header(header::HOST, HOST)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from(form))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        origin: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(header::HOST, HOST)
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 65536).await.unwrap();
        (
            parts.status,
            serde_json::from_slice(&bytes).unwrap_or_default(),
        )
    }

    async fn mcp_initialize(&self) -> StatusCode {
        self.app
            .clone()
            .oneshot(
                Request::post("/.mcp")
                    .header(header::HOST, HOST)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": "2025-11-25",
                                "capabilities": {},
                                "clientInfo": {"name": "test", "version": "1"}
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }
}

#[tokio::test]
async fn mcp_settings_are_admin_writable_and_member_readable() {
    let f = Fixture::new(true, Some("https://docs.example.test")).await;
    let (status, body) = f
        .request("GET", "/mcp/settings", Some(&f.admin), ORIGIN, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], true);
    assert_eq!(body["available"], true);
    assert_eq!(body["disabledByEnv"], false);
    assert_eq!(body["endpoint"], format!("{ORIGIN}/.mcp"));
    assert_eq!(body["publicReaderUrl"], "https://docs.example.test");
    assert!(body["publicReaderUrlError"].is_null());
    assert!(body.get("token").is_none());
    assert!(body.get("credentialVersion").is_none());

    let (status, body) = f
        .request("GET", "/mcp/settings", Some(&f.member), ORIGIN, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["endpoint"], format!("{ORIGIN}/.mcp"));

    let (status, body) = f
        .request(
            "PUT",
            "/mcp/settings",
            Some(&f.member),
            ORIGIN,
            json!({"enabled": false}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "account_admin_required");
}

#[tokio::test]
async fn mcp_settings_toggle_is_live_and_requires_admin() {
    let f = Fixture::new(false, None).await;
    assert_eq!(f.mcp_initialize().await, StatusCode::NOT_FOUND);

    let (status, body) = f
        .request(
            "PUT",
            "/mcp/settings",
            Some(&f.admin),
            ORIGIN,
            json!({"enabled": true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], true);
    assert_eq!(f.mcp_initialize().await, StatusCode::UNAUTHORIZED);

    let (status, _) = f
        .request(
            "PUT",
            "/mcp/settings",
            Some(&f.member),
            ORIGIN,
            json!({"enabled": false}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = f
        .request(
            "PUT",
            "/mcp/settings",
            Some(&f.admin),
            "http://other.example.test",
            json!({"enabled": false}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = f
        .request(
            "PUT",
            "/mcp/settings",
            Some(&f.admin),
            ORIGIN,
            json!({"enabled": false}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false);
    assert_eq!(f.mcp_initialize().await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn grants_are_scoped_and_revocable() {
    let f = Fixture::new(true, None).await;
    let (status, body) = f
        .request("GET", "/mcp/grants", Some(&f.member), ORIGIN, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"], f.member_grant);
    assert_eq!(list[0]["clientName"], "Member app");
    assert_eq!(list[0]["clientKind"], "dcr");
    assert_eq!(list[0]["spaces"], json!([{"id":"left","name":"Left"}]));
    assert!(list[0]["createdAt"].as_str().unwrap().ends_with('Z'));
    assert!(list[0]["lastUsedAt"].is_null());
    assert!(list[0].get("refresh").is_none());
    assert!(list[0].get("credentialVersion").is_none());

    let (status, body) = f
        .request("GET", "/mcp/grants", Some(&f.other), ORIGIN, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap()[0]["id"], f.other_grant);

    let (status, _) = f
        .request(
            "DELETE",
            &format!("/mcp/grants/{}", f.other_grant),
            Some(&f.member),
            ORIGIN,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, body) = f
        .request("GET", "/mcp/grants", Some(&f.other), ORIGIN, Value::Null)
        .await;
    assert_eq!(body.as_array().unwrap().len(), 1);

    let (status, _) = f
        .request(
            "DELETE",
            &format!("/mcp/grants/{}", f.member_grant),
            Some(&f.member),
            "http://other.example.test",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = f
        .request(
            "DELETE",
            &format!("/mcp/grants/{}", f.member_grant),
            Some(&f.member),
            ORIGIN,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, body) = f
        .request("GET", "/mcp/grants", Some(&f.member), ORIGIN, Value::Null)
        .await;
    assert!(body.as_array().unwrap().is_empty());

    let (status, _) = f
        .request(
            "DELETE",
            &format!("/mcp/grants/{}", f.member_grant),
            Some(&f.member),
            ORIGIN,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn missing_public_reader_url_is_reported_without_secrets() {
    let f = Fixture::new(true, None).await;
    let (status, body) = f
        .request("GET", "/mcp/settings", Some(&f.admin), ORIGIN, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["publicReaderUrl"].is_null());
    assert_eq!(body["publicReaderUrlError"], "reader_url_unavailable");
    let text = body.to_string();
    assert!(!text.contains("refresh"));
    assert!(!text.contains("credential"));
}
