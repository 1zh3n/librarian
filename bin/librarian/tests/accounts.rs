use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::{
    auth::{scoped_auth_cookie_name, totp},
    multi::users::{Profile, UserStore},
};
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
        session_cookie(&response)
    }

    async fn password_challenge(&self, username: &str, password: &str) -> String {
        let response = self.login_response(username, password).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        cookie(&response, "totp")
    }

    async fn totp_submit(
        &self,
        challenge: &str,
        code: &str,
        next: &str,
    ) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::post(format!("/.auth/librarian/totp?next={next}"))
                    .header(header::HOST, HOST)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::COOKIE, challenge)
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from(format!("code={code}")))
                    .unwrap(),
            )
            .await
            .unwrap()
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

    async fn public(&self, method: &str, path: &str, input: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header(header::HOST, HOST)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 65536).await.unwrap();
        (
            parts.status,
            serde_json::from_slice(&bytes).unwrap_or_default(),
        )
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

fn cookie(response: &axum::response::Response, suffix: &str) -> String {
    let name = scoped_auth_cookie_name(HOST, suffix);
    for value in response.headers().get_all(header::SET_COOKIE) {
        let value = value.to_str().unwrap();
        if value.starts_with(&format!("{name}=")) {
            return value.split(';').next().unwrap().to_owned();
        }
    }
    panic!("missing {suffix} cookie");
}

fn session_cookie(response: &axum::response::Response) -> String {
    let name = scoped_auth_cookie_name(HOST, "");
    for value in response.headers().get_all(header::SET_COOKIE) {
        let value = value.to_str().unwrap();
        if value.starts_with(&format!("{name}=")) {
            return value.split(';').next().unwrap().to_owned();
        }
    }
    panic!("missing session cookie");
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tokio::test]
async fn totp_enrollment_login_wrong_code_and_recovery() {
    let f = Fixture::new();
    let cookie = f.login("member", ORIGINAL).await;
    let (status, start) = f
        .request("POST", "/session/totp/start", &cookie, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{start}");
    let secret = start["secret"].as_str().unwrap().to_owned();
    assert!(start["uri"]
        .as_str()
        .unwrap()
        .starts_with("otpauth://totp/"));

    let code = totp::current_code(&secret, now()).unwrap();
    let (status, enabled) = f
        .request(
            "POST",
            "/session/totp/verify",
            &cookie,
            json!({"secret": secret, "code": code}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    let recovery = enabled["recoveryCodes"][0].as_str().unwrap().to_owned();
    let (status, status_body) = f
        .request("GET", "/session/totp", &cookie, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(status_body["enabled"], true);
    assert_eq!(status_body["recoveryRemaining"], 10);

    let challenge = f.password_challenge("member", ORIGINAL).await;
    let response = f.totp_submit(&challenge, &code, "/").await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let session = session_cookie(&response);
    let (status, _) = f.request("GET", "/session", &session, Value::Null).await;
    assert_eq!(status, StatusCode::OK);

    let challenge = f.password_challenge("member", ORIGINAL).await;
    let response = f.totp_submit(&challenge, "not-a-code", "/").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let challenge = f.password_challenge("member", ORIGINAL).await;
    let response = f.totp_submit(&challenge, &recovery, "/").await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let challenge = f.password_challenge("member", ORIGINAL).await;
    let response = f.totp_submit(&challenge, &recovery, "/").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn administrator_resets_two_factor_and_revokes_sessions() {
    let f = Fixture::new();
    let cookie = f.login("member", ORIGINAL).await;
    let (_, start) = f
        .request("POST", "/session/totp/start", &cookie, Value::Null)
        .await;
    let secret = start["secret"].as_str().unwrap();
    let code = totp::current_code(secret, now()).unwrap();
    let (status, _) = f
        .request(
            "POST",
            "/session/totp/verify",
            &cookie,
            json!({"secret": secret, "code": code}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let admin = f.login("admin", ORIGINAL).await;
    let (status, body) = f
        .request("POST", "/accounts/member/totp/reset", &admin, Value::Null)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, _) = f.request("GET", "/session", &cookie, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let session = f.login("member", ORIGINAL).await;
    let (status, status_body) = f
        .request("GET", "/session/totp", &session, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(status_body["enabled"], false);
}

#[tokio::test]
async fn invites_are_one_time_and_create_a_totp_account() {
    let f = Fixture::new();
    let admin = f.login("admin", ORIGINAL).await;
    let (status, workspace) = f
        .request("POST", "/workspaces", &admin, json!({"name":"邀请空间"}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{workspace}");
    let workspace_id = workspace["id"].as_str().unwrap().to_owned();

    let (status, created) = f
        .request(
            "POST",
            "/invites",
            &admin,
            json!({
                "username":"invited-reader",
                "admin":false,
                "role":"write",
                "workspaceIds":[workspace_id],
                "expiresInDays":7
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let token = created["token"].as_str().unwrap().to_owned();
    let invite_id = created["id"].as_str().unwrap().to_owned();

    let (status, preview) = f
        .public("GET", &format!("/invites/{token}"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["username"], "invited-reader");
    assert_eq!(preview["workspaces"][0]["id"], workspace_id);

    let secret = totp::generate_secret();
    let code = totp::current_code(&secret, now()).unwrap();
    let (status, accepted) = f
        .public(
            "POST",
            &format!("/invites/{token}/accept"),
            json!({"password":"invited-reader-password","totpSecret":secret,"code":code}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["recoveryCodes"].as_array().unwrap().len(), 10);

    let (status, _) = f
        .public(
            "POST",
            &format!("/invites/{token}/accept"),
            json!({"password":"another-long-password","totpSecret":secret,"code":code}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let challenge = f
        .password_challenge("invited-reader", "invited-reader-password")
        .await;
    let response = f
        .totp_submit(
            &challenge,
            &totp::current_code(&secret, now()).unwrap(),
            "/",
        )
        .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let session = session_cookie(&response);
    let (status, workspaces) = f.request("GET", "/workspaces", &session, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(workspaces
        .as_array()
        .unwrap()
        .iter()
        .any(|workspace| workspace["id"] == workspace_id));

    let (status, invites) = f.request("GET", "/invites", &admin, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(invites
        .as_array()
        .unwrap()
        .iter()
        .any(|invite| invite["id"] == invite_id && invite["acceptedAt"].is_number()));

    let (status, created) = f
        .request(
            "POST",
            "/invites",
            &admin,
            json!({
                "username":"revoked-reader",
                "admin":false,
                "role":"read",
                "workspaceIds":[workspace_id],
                "expiresInDays":7
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let revoked_token = created["token"].as_str().unwrap();
    let revoked_id = created["id"].as_str().unwrap();
    let (status, _) = f
        .request(
            "DELETE",
            &format!("/invites/{revoked_id}"),
            &admin,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = f
        .public("GET", &format!("/invites/{revoked_token}"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn totp_step_up_is_required_for_security_downgrades() {
    let f = Fixture::new();
    let admin = f.login("admin", ORIGINAL).await;
    let (_, start) = f
        .request("POST", "/session/totp/start", &admin, Value::Null)
        .await;
    let secret = start["secret"].as_str().unwrap().to_owned();
    let code = totp::current_code(&secret, now()).unwrap();
    let (status, _) = f
        .request(
            "POST",
            "/session/totp/verify",
            &admin,
            json!({"secret": secret, "code": code}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, workspace) = f
        .request(
            "POST",
            "/workspaces",
            &admin,
            json!({"name":"分步验证空间"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{workspace}");
    let id = workspace["id"].as_str().unwrap();
    let path = format!("/workspaces/{id}");
    let (status, raised) = f
        .request(
            "PATCH",
            &path,
            &admin,
            json!({"securityLevel":"confidential"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{raised}");

    let (status, error) = f
        .request(
            "PATCH",
            &path,
            &admin,
            json!({"securityLevel":"internal","confirmSecurityDowngrade":true}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "step_up_required");

    let (status, step) = f
        .request(
            "POST",
            "/session/step-up",
            &admin,
            json!({"code": totp::current_code(&secret, now()).unwrap()}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{step}");
    let token = step["token"].as_str().unwrap();
    let (status, lowered) = f
        .request(
            "PATCH",
            &path,
            &admin,
            json!({
                "securityLevel":"internal",
                "confirmSecurityDowngrade":true,
                "stepUpToken":token
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{lowered}");
    assert_eq!(lowered["securityLevel"], "internal");
}

#[tokio::test]
async fn totp_step_up_is_required_for_anonymous_shares() {
    let f = Fixture::new();
    let admin = f.login("admin", ORIGINAL).await;
    let (_, start) = f
        .request("POST", "/session/totp/start", &admin, Value::Null)
        .await;
    let secret = start["secret"].as_str().unwrap().to_owned();
    let code = totp::current_code(&secret, now()).unwrap();
    let (status, _) = f
        .request(
            "POST",
            "/session/totp/verify",
            &admin,
            json!({"secret": secret, "code": code}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, workspace) = f
        .request(
            "POST",
            "/workspaces",
            &admin,
            json!({"name":"分步分享空间"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{workspace}");
    let workspace_id = workspace["id"].as_str().unwrap();
    let (status, document) = f
        .request(
            "POST",
            &format!("/workspaces/{workspace_id}/documents"),
            &admin,
            json!({"path":"Note.md","markdown":"# Note\n","baseRevision":null}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{document}");
    let document_id = document["document"]["id"].as_str().unwrap();
    let body = json!({"kind":"current","audience":"share","documentIds":[document_id]});
    let snapshots = format!("/workspaces/{workspace_id}/snapshots");

    let (status, error) = f.request("POST", &snapshots, &admin, body.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "step_up_required");

    let (_, step) = f
        .request(
            "POST",
            "/session/step-up",
            &admin,
            json!({"code": totp::current_code(&secret, now()).unwrap()}),
        )
        .await;
    let token = step["token"].as_str().unwrap();
    let (status, created) = f
        .request(
            "POST",
            &snapshots,
            &admin,
            json!({
                "kind":"current",
                "audience":"share",
                "documentIds":[document_id],
                "stepUpToken":token
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
}

#[tokio::test]
async fn totp_step_up_is_required_for_publications() {
    let f = Fixture::new();
    let admin = f.login("admin", ORIGINAL).await;
    let (_, start) = f
        .request("POST", "/session/totp/start", &admin, Value::Null)
        .await;
    let secret = start["secret"].as_str().unwrap().to_owned();
    let (status, _) = f
        .request(
            "POST",
            "/session/totp/verify",
            &admin,
            json!({"secret": secret, "code": totp::current_code(&secret, now()).unwrap()}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let operation = "72a6f960-2014-4093-9be1-5de2bafc78dc";
    let body = json!({
        "workspaceId":"missing",
        "targetId":"missing",
        "commitId":"0123456789abcdef0123456789abcdef01234567",
        "documentIds":["missing"],
        "operationId":operation,
        "confirm":true
    });
    let (status, error) = f
        .request("POST", "/publications", &admin, body.clone())
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "step_up_required");

    let (status, error) = f
        .request("POST", "/publications/missing/confirm", &admin, json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "step_up_required");

    let (_, step) = f
        .request(
            "POST",
            "/session/step-up",
            &admin,
            json!({"code": totp::current_code(&secret, now()).unwrap()}),
        )
        .await;
    let token = step["token"].as_str().unwrap();

    let mut confirmed = body;
    confirmed["stepUpToken"] = json!(token);
    let (status, error) = f.request("POST", "/publications", &admin, confirmed).await;
    assert_ne!(status, StatusCode::FORBIDDEN, "{error}");
    assert_ne!(error["code"], "step_up_required");

    let (status, _) = f
        .request(
            "POST",
            "/publications/missing/confirm",
            &admin,
            json!({"stepUpToken":token}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn lists_and_revokes_browser_sessions() {
    let f = Fixture::new();
    let first = f.login("member", ORIGINAL).await;
    let second = f.login("member", ORIGINAL).await;

    let (status, list) = f
        .request("GET", "/session/sessions", &first, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let sessions = list["sessions"].as_array().unwrap();
    assert!(sessions.len() >= 2);
    let current = sessions
        .iter()
        .find(|session| session["current"] == true)
        .expect("one current session");
    let current_id = current["id"].as_str().unwrap().to_owned();
    let other = sessions
        .iter()
        .find(|session| session["current"] == false)
        .expect("one other session")["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (status, _) = f
        .request(
            "DELETE",
            &format!("/session/sessions/{other}"),
            &first,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = f.request("GET", "/session", &second, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = f.request("GET", "/session", &first, Value::Null).await;
    assert_eq!(status, StatusCode::OK);

    let (status, error) = f
        .request(
            "DELETE",
            &format!("/session/sessions/{current_id}"),
            &first,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(error["code"], "current_session");

    let third = f.login("member", ORIGINAL).await;
    let (status, revoked) = f
        .request(
            "POST",
            "/session/sessions/revoke-others",
            &first,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert!(revoked["revoked"].as_u64().unwrap() >= 1);
    let (status, _) = f.request("GET", "/session", &third, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = f.request("GET", "/session", &first, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
}
