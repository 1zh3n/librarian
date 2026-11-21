//! Managed global actions use the Reader's live workspace and membership services.
use axum::{
    body::{to_bytes, Body},
    http::{header, Request},
    Router,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

#[path = "fixtures/ai-materials/setup.rs"]
mod managed;

const HOST: &str = "127.0.0.1:6947";
const ORIGIN: &str = "http://127.0.0.1:6947";

struct Site {
    root: TempDir,
    app: Router,
    owner: String,
    member: String,
    admin: String,
    owner_token: String,
}

async fn login(app: &Router, username: &str) -> String {
    let req = Request::post("/.auth/librarian/login")
        .header(header::HOST, HOST)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(format!(
            "username={username}&password=synthetic-password"
        )))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 303);
    res.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}

impl Site {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for (name, admin) in [("owner", false), ("member", false), ("admin", true)] {
            users
                .create_user(name, "synthetic-password", admin, Profile::default())
                .unwrap();
        }
        let owner_token = format!(
            "Bearer {}",
            users.create_token("owner", "management-test").unwrap()
        );
        let app = librarian::Product::open(root.path(), 6947)
            .unwrap()
            .router();
        managed::configure(root.path()).unwrap();
        Self {
            owner_token,
            owner: login(&app, "owner").await,
            member: login(&app, "member").await,
            admin: login(&app, "admin").await,
            root,
            app,
        }
    }

    fn db(&self) -> Connection {
        Connection::open(self.root.path().join(".librarian/metadata.sqlite3")).unwrap()
    }

    fn pending_operation(&self) -> String {
        self.db()
            .query_row(
                "SELECT operation_id FROM ai_space_management WHERE receipt IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    async fn operation(&self, op: &str) -> Value {
        self.ok(
            &self.owner,
            "GET",
            &format!("/ai/operations/{op}"),
            Value::Null,
            200,
        )
        .await
    }

    async fn call(&self, credential: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(header::HOST, HOST)
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json");
        if credential == managed::RUNNER {
            req = req
                .header(header::AUTHORIZATION, format!("Bearer {credential}"))
                .header("x-librarian-runner-id", managed::INSTANCE);
        } else if credential.starts_with("Bearer ") {
            req = req.header(header::AUTHORIZATION, credential);
        } else {
            req = req.header(header::COOKIE, credential);
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let code = res.status().as_u16();
        let bytes = to_bytes(res.into_body(), 200_000).await.unwrap();
        (code, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    async fn ok(&self, who: &str, method: &str, path: &str, body: Value, status: u16) -> Value {
        let (code, out) = self.call(who, method, path, body).await;
        assert_eq!(code, status, "{method} {path}: {out}");
        out
    }

    async fn claim(&self, who: &str, mode: &str) -> String {
        let c = self
            .ok(
                who,
                "POST",
                "/ai/conversations",
                json!({"scope":"global"}),
                201,
            )
            .await;
        let turns = format!("/ai/conversations/{}/turns", c["id"].as_str().unwrap());
        let turn = self
            .ok(
                who,
                "POST",
                &turns,
                json!({"clientTurnId":c["id"],"prompt":"管理工作区","mode":mode}),
                202,
            )
            .await;
        let claim = self
            .ok(
                managed::RUNNER,
                "POST",
                "/ai/runner/v2/claims",
                json!({}),
                200,
            )
            .await;
        assert_eq!(claim["operationId"], turn["operationId"]);
        format!(
            "/ai/runner/v2/claims/{}/result",
            claim["leaseId"].as_str().unwrap()
        )
    }

    async fn result(&self, lease: &str, action: &Value) -> (u16, Value) {
        self.call(
            managed::RUNNER,
            "PUT",
            lease,
            json!({"answer":"完成","sourceIds":[],"edits":[],"action":action}),
        )
        .await
    }

    async fn edit(&self, who: &str, action: Value) -> Value {
        let lease = self.claim(who, "edit").await;
        let (code, op) = self.result(&lease, &action).await;
        assert_eq!(code, 200, "{op}");
        assert_eq!(op["status"], "succeeded");
        op["workspaceManagement"].clone()
    }
    async fn manual_space(&self) -> String {
        self.ok(
            &self.owner,
            "POST",
            "/workspaces",
            json!({"name":"原名"}),
            201,
        )
        .await["id"]
            .as_str()
            .unwrap()
            .into()
    }
}

#[tokio::test]
async fn zero_space_user_creates_once_even_if_the_final_operation_receipt_is_interrupted() {
    let s = Site::new().await;
    assert_eq!(
        s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await,
        json!([])
    );
    let lease = s.claim(&s.owner, "edit").await;
    let action = json!({"kind":"create_workspace","name":"我的首次创建"});
    // Interrupt the operation write after the native configuration mutation.
    s.db()
        .execute_batch(
            "CREATE TRIGGER interrupt_management BEFORE UPDATE ON ai_operations
        WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'interrupted completion'); END;",
        )
        .unwrap();
    assert_eq!(s.result(&lease, &action).await.0, 500);
    let spaces = s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await;
    assert_eq!(spaces.as_array().unwrap().len(), 1, "{spaces}");
    let id = &spaces[0]["id"];
    assert_eq!(spaces[0]["canManage"], true);
    s.db()
        .execute_batch("DROP TRIGGER interrupt_management;")
        .unwrap();
    let (code, op) = s.result(&lease, &action).await;
    assert_eq!(code, 200, "{op}");
    assert_eq!(
        op["workspaceManagement"],
        json!({"kind":"create_workspace","workspaceId":id,"name":"我的首次创建"})
    );
    assert_eq!(s.result(&lease, &action).await, (200, op));
    assert_eq!(
        s.result(
            &lease,
            &json!({"kind":"create_workspace","name":"不同请求"})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await,
        spaces
    );
}

#[tokio::test]
async fn ask_cannot_create_and_a_regular_writer_cannot_manage() {
    let s = Site::new().await;
    let ask = s.claim(&s.owner, "chat").await;
    let (status, body) = s
        .result(&ask, &json!({"kind":"create_workspace","name":"不可创建"}))
        .await;
    assert!([403, 422].contains(&status), "{status} {body}");
    assert_eq!(
        s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await,
        json!([])
    );
    let id = s.manual_space().await;
    let path = format!("/workspaces/{id}/members/member");
    s.ok(&s.owner, "PUT", &path, json!({"role":"write"}), 200)
        .await;
    let lease = s.claim(&s.member, "edit").await;
    let rename = json!({"kind":"rename_workspace","workspaceId":id,"name":"越权改名"});
    let (status, error) = s.result(&lease, &rename).await;
    assert_eq!(status, 403, "{error}");
    s.ok(&s.owner, "DELETE", &path, Value::Null, 200).await;
    assert_ne!(s.result(&lease, &rename).await.0, 200);
    assert_eq!(
        s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await[0]["name"],
        "原名"
    );
}

#[tokio::test]
async fn rename_preserves_document_identity_and_replay_preserves_subsequent_manual_rename() {
    let s = Site::new().await;
    let id = s.manual_space().await;
    let doc = s
        .ok(
            &s.owner,
            "POST",
            &format!("/workspaces/{id}/documents"),
            json!({"path":"笔记.md","markdown":"原文","baseRevision":null}),
            201,
        )
        .await;
    let lease = s.claim(&s.admin, "edit").await;
    let action = json!({"kind":"rename_workspace","workspaceId":id,"name":"新名"});
    let (code, op) = s.result(&lease, &action).await;
    assert_eq!(code, 200, "{op}");
    assert_eq!(
        op["workspaceManagement"],
        json!({"kind":"rename_workspace","workspaceId":id,"name":"新名"})
    );
    assert_eq!(
        s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await[0]["name"],
        "新名"
    );
    let document_id = doc["documentId"].as_str().unwrap();
    let original_link = format!("/workspaces/{id}/documents/{document_id}");
    assert_eq!(doc["readerPath"], original_link);
    let snapshot = s
        .ok(
            &s.owner,
            "GET",
            &format!("/documents/{document_id}"),
            Value::Null,
            200,
        )
        .await;
    assert_eq!(snapshot["readerPath"], original_link);
    assert_eq!(snapshot["markdown"], "原文");
    s.ok(
        &s.owner,
        "PATCH",
        &format!("/workspaces/{id}"),
        json!({"name":"后续手动改名"}),
        200,
    )
    .await;
    assert_eq!(s.result(&lease, &action).await, (200, op));
    assert_eq!(
        s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await[0]["name"],
        "后续手动改名"
    );
}

#[tokio::test]
async fn member_changes_affect_reader_access_and_protect_creator() {
    let s = Site::new().await;
    let id = s.manual_space().await;
    let set = |username: &str, role: &str| json!({"kind":"set_workspace_member","workspaceId":id,"username":username,"role":role});
    let remove = |username: &str| json!({"kind":"remove_workspace_member","workspaceId":id,"username":username});
    let read = s.edit(&s.owner, set("member", "read")).await;
    assert_eq!(
        read,
        json!({"kind":"set_workspace_member","workspaceId":id,"name":"原名","username":"member","role":"read"})
    );
    assert_eq!(
        s.ok(&s.member, "GET", "/workspaces", Value::Null, 200)
            .await[0]["canWrite"],
        false
    );
    s.edit(&s.owner, set("member", "write")).await;
    assert_eq!(
        s.ok(&s.member, "GET", "/workspaces", Value::Null, 200)
            .await[0]["canWrite"],
        true
    );
    let removed = s.edit(&s.owner, remove("member")).await;
    assert_eq!(
        removed,
        json!({"kind":"remove_workspace_member","workspaceId":id,"name":"原名","username":"member"})
    );
    assert_eq!(
        s.ok(&s.member, "GET", "/workspaces", Value::Null, 200)
            .await,
        json!([])
    );
    let lease = s.claim(&s.admin, "edit").await;
    let (code, err) = s.result(&lease, &remove("owner")).await;
    assert_eq!(code, 409, "{err}");
    assert_eq!(err["code"], "workspace_owner_protected");
}

#[tokio::test]
async fn membership_requires_a_browser_originated_turn_even_for_the_owner() {
    let s = Site::new().await;
    let id = s.manual_space().await;
    let lease = s.claim(&s.owner_token, "edit").await;
    let (code,err)=s.result(&lease,&json!({"kind":"set_workspace_member","workspaceId":id,"username":"member","role":"write"})).await;
    assert_eq!(code, 401, "{err}");
    assert_eq!(err["code"], "browser_session_required");
    assert_eq!(
        s.ok(&s.member, "GET", "/workspaces", Value::Null, 200)
            .await,
        json!([])
    );
}

#[tokio::test]
async fn revoked_account_cannot_use_an_already_issued_lease_to_create() {
    let s = Site::new().await;
    let lease = s.claim(&s.owner, "edit").await;
    s.ok(
        &s.admin,
        "PATCH",
        "/accounts/owner",
        json!({"disabled":true}),
        200,
    )
    .await;
    let (code, body) = s
        .result(
            &lease,
            &json!({"kind":"create_workspace","name":"停用后创建"}),
        )
        .await;
    assert!([401, 403, 404, 409].contains(&code), "{code} {body}");
    assert_eq!(
        s.ok(&s.admin, "GET", "/workspaces", Value::Null, 200).await,
        json!([])
    );
}

#[tokio::test]
async fn interrupted_native_creation_recovers_the_same_workspace_after_restart() {
    let mut s = Site::new().await;
    let lease = s.claim(&s.owner, "edit").await;
    let action = json!({"kind":"create_workspace","name":"初始名称"});
    s.db()
        .execute_batch(
            "CREATE TRIGGER interrupt_receipt BEFORE UPDATE OF receipt ON ai_space_management
         BEGIN SELECT RAISE(ABORT,'interrupted management receipt'); END;",
        )
        .unwrap();
    assert_eq!(s.result(&lease, &action).await.0, 500);
    let spaces = s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await;
    let id = spaces[0]["id"].as_str().unwrap();
    s.ok(
        &s.owner,
        "PATCH",
        &format!("/workspaces/{id}"),
        json!({"name":"手动更名"}),
        200,
    )
    .await;
    s.db()
        .execute_batch("DROP TRIGGER interrupt_receipt;")
        .unwrap();
    s.app = Router::new();
    s.app = librarian::Product::open(s.root.path(), 6947)
        .unwrap()
        .router();
    s.db()
        .execute("UPDATE ai_connections SET version=version+1", [])
        .unwrap();
    let result = s.operation(&s.pending_operation()).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(
        result["workspaceManagement"],
        json!({"kind":"create_workspace","workspaceId":id,"name":"初始名称"})
    );
    let final_spaces = s.ok(&s.owner, "GET", "/workspaces", Value::Null, 200).await;
    assert_eq!(final_spaces.as_array().unwrap().len(), 1);
    assert_eq!(final_spaces[0]["id"], id);
    assert_eq!(final_spaces[0]["name"], "手动更名");
}

#[tokio::test]
async fn interrupted_member_grant_keeps_its_receipt_after_manual_revocation() {
    let s = Site::new().await;
    let id = s.manual_space().await;
    let lease = s.claim(&s.owner, "edit").await;
    let action =
        json!({"kind":"set_workspace_member","workspaceId":id,"username":"member","role":"write"});
    s.db().execute_batch("CREATE TRIGGER interrupt_member BEFORE UPDATE OF receipt ON ai_space_management BEGIN SELECT RAISE(ABORT,'interrupted grant receipt'); END;").unwrap();
    assert_eq!(s.result(&lease, &action).await.0, 500);
    let spaces = s
        .ok(&s.member, "GET", "/workspaces", Value::Null, 200)
        .await;
    assert_eq!(spaces[0]["canWrite"], true);
    s.ok(
        &s.owner,
        "DELETE",
        &format!("/workspaces/{id}/members/member"),
        Value::Null,
        200,
    )
    .await;
    let grant_id = s.pending_operation();
    s.db()
        .execute_batch("DROP TRIGGER interrupt_member;")
        .unwrap();
    s.edit(
        &s.owner,
        json!({"kind":"rename_workspace","workspaceId":id,"name":"后续 AI 更名"}),
    )
    .await;
    s.db()
        .execute("UPDATE ai_connections SET version=version+1", [])
        .unwrap();
    let result = s.operation(&grant_id).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(
        result["workspaceManagement"],
        json!({"kind":"set_workspace_member","workspaceId":id,"name":"原名","username":"member","role":"write"})
    );
    assert_eq!(
        s.ok(&s.member, "GET", "/workspaces", Value::Null, 200)
            .await,
        json!([])
    );
}
