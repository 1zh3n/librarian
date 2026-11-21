use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:6947";
const HOST: &str = "127.0.0.1:6947";
const ORIGINAL: &str = "example-initial-password";
const REPLACEMENT: &str = "example-replacement-password";

struct Fixture {
    _root: TempDir,
    app: Router,
    admin_token: String,
    member_token: String,
}

impl Fixture {
    fn new() -> Self {
        Self::with_member_password(ORIGINAL)
    }

    fn with_member_password(member_password: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for (name, password, admin) in [
            ("admin", ORIGINAL, true),
            ("owner", ORIGINAL, false),
            ("member", member_password, false),
        ] {
            users
                .create_user(name, password, admin, Profile::default())
                .unwrap();
        }
        let admin_token = users.create_token("admin", "account-fixture").unwrap();
        let member_token = users.create_token("member", "account-fixture").unwrap();
        let app = librarian::Product::open(root.path(), 6947)
            .unwrap()
            .router();
        Self {
            _root: root,
            app,
            admin_token,
            member_token,
        }
    }

    async fn login_response(&self, username: &str, password: &str) -> axum::response::Response {
        let form = format!("username={username}&password={password}");
        self.app
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
            .unwrap()
    }

    async fn login(&self, username: &str, password: &str) -> String {
        let response = self.login_response(username, password).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        credential: Option<(header::HeaderName, &str)>,
        origin: &str,
        input: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(header::HOST, HOST)
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some((name, value)) = credential {
            request = request.header(name, value);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(input.to_string())).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 65536).await.unwrap();
        (
            parts.status,
            serde_json::from_slice(&bytes).unwrap_or_default(),
        )
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        input: Value,
    ) -> (StatusCode, Value) {
        self.send(method, path, Some((header::COOKIE, cookie)), ORIGIN, input)
            .await
    }

    async fn with_token(&self, path: &str, token: &str) -> StatusCode {
        self.send(
            "GET",
            path,
            Some((header::AUTHORIZATION, &format!("Bearer {token}"))),
            ORIGIN,
            Value::Null,
        )
        .await
        .0
    }
}

#[tokio::test]
async fn member_can_replace_a_legacy_password_above_the_new_password_limit() {
    let legacy_password = "p".repeat(4100);
    let f = Fixture::with_member_password(&legacy_password);
    let member = f.login("member", &legacy_password).await;
    assert_eq!(
        f.request(
            "PUT",
            "/session/password",
            &member,
            json!({ "currentPassword": legacy_password, "password": REPLACEMENT }),
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    f.login("member", REPLACEMENT).await;
}

#[tokio::test]
async fn administrator_creates_and_lists_redacted_accounts() {
    let f = Fixture::new();
    assert_eq!(
        f.send("GET", "/accounts", None, ORIGIN, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.with_token("/accounts", &f.admin_token).await,
        StatusCode::UNAUTHORIZED
    );
    let member = f.login("member", ORIGINAL).await;
    let admin = f.login("admin", ORIGINAL).await;
    assert_eq!(
        f.request("GET", "/accounts", &member, Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    let account = json!({"username":"new-reader","password":ORIGINAL});
    assert_eq!(
        f.send(
            "POST",
            "/accounts",
            Some((header::COOKIE, &admin)),
            "https://different.example.test",
            account.clone(),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "POST",
            "/accounts",
            &admin,
            json!({"username":"weak","password":"short"}),
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let summary = json!({"username":"new-reader","isAdmin":false,"disabled":false});
    assert_eq!(
        f.request("POST", "/accounts", &admin, account.clone())
            .await,
        (StatusCode::CREATED, summary.clone())
    );
    assert_eq!(
        f.request("POST", "/accounts", &admin, account).await.0,
        StatusCode::CONFLICT
    );
    let (status, accounts) = f.request("GET", "/accounts", &admin, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(accounts.as_array().unwrap().contains(&summary));
    assert_eq!(
        f.request("GET", "/session", &admin, Value::Null).await.1["isAdmin"],
        true
    );
    let new_cookie = f.login("new-reader", ORIGINAL).await;
    assert_eq!(
        f.request("GET", "/session", &new_cookie, Value::Null)
            .await
            .1["isAdmin"],
        false
    );
    let (status, workspace) = f
        .request("POST", "/workspaces", &admin, json!({"name":"New readers"}))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = workspace["id"].as_str().unwrap();
    let assignment = format!("/workspaces/{id}/members/new-reader");
    assert_eq!(
        f.request("PUT", &assignment, &admin, json!({"role":"read"}))
            .await
            .0,
        StatusCode::OK
    );
    let (_, opened) = f
        .request("GET", "/workspaces", &new_cookie, Value::Null)
        .await;
    assert_eq!(opened[0]["id"], id);
    assert_eq!(opened[0]["canWrite"], false);
}

#[tokio::test]
async fn password_changes_disable_and_revoke_use_live_account_state() {
    let f = Fixture::new();
    let admin = f.login("admin", ORIGINAL).await;
    let member = f.login("member", ORIGINAL).await;
    assert_eq!(
        f.request(
            "PATCH",
            "/accounts/member",
            &admin,
            json!({"disabled":false}),
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.with_token("/workspaces", &f.member_token).await,
        StatusCode::OK
    );
    assert_eq!(
        f.request("PATCH", "/accounts/admin", &admin, json!({"disabled":true}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.request(
            "PUT",
            "/session/password",
            &member,
            json!({"currentPassword":"another-example-password","password":REPLACEMENT}),
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "PUT",
            "/session/password",
            &member,
            json!({"currentPassword":ORIGINAL,"password":REPLACEMENT}),
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.request("GET", "/session", &member, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.with_token("/workspaces", &f.member_token).await,
        StatusCode::UNAUTHORIZED
    );
    let changed = f.login("member", REPLACEMENT).await;
    assert_eq!(
        f.request(
            "POST",
            "/accounts/member/sessions/revoke",
            &admin,
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.request("GET", "/session", &changed, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request(
            "PUT",
            "/accounts/member/password",
            &admin,
            json!({"password":ORIGINAL})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let reset = f.login("member", ORIGINAL).await;
    assert_eq!(
        f.request(
            "PATCH",
            "/accounts/member",
            &admin,
            json!({"disabled":true})
        )
        .await
        .1["disabled"],
        true
    );
    assert_eq!(
        f.login_response("member", ORIGINAL).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request(
            "PATCH",
            "/accounts/member",
            &admin,
            json!({"disabled":false})
        )
        .await
        .1["disabled"],
        false
    );
    assert_eq!(
        f.request("GET", "/session", &reset, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    f.login("member", ORIGINAL).await;
}

#[tokio::test]
async fn workspace_owner_grants_downgrades_and_removes_live_access() {
    let f = Fixture::new();
    let owner = f.login("owner", ORIGINAL).await;
    let member = f.login("member", ORIGINAL).await;
    let (status, created) = f
        .request(
            "POST",
            "/workspaces",
            &owner,
            json!({"name":"Member fixture"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let workspace = created["id"].as_str().unwrap();
    let members = format!("/workspaces/{workspace}/members");
    let assignment = format!("{members}/member");
    let documents = format!("/workspaces/{workspace}/documents");
    assert_eq!(
        f.request("GET", &documents, &member, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request("PUT", &assignment, &owner, json!({"role":"write"}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request("GET", &members, &member, Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    let note = json!({"path":"Member note.md","markdown":"# Member note\n","baseRevision":null});
    assert_eq!(
        f.request("POST", &documents, &member, note).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        f.request("PUT", &assignment, &owner, json!({"role":"read"}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "POST",
            &documents,
            &member,
            json!({"path":"Second.md","markdown":"","baseRevision":null})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request("GET", &documents, &member, Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        f.request("DELETE", &format!("{members}/owner"), &owner, Value::Null)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (status, remaining) = f.request("DELETE", &assignment, &owner, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        remaining,
        json!([{"username":"owner","role":"write","isOwner":true}])
    );
    assert_eq!(
        f.request("GET", &documents, &member, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
}
