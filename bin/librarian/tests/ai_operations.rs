use std::{fs, path::PathBuf, process::Command};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server_common::revision::sha256_hex;
use tempfile::TempDir;
use tower::ServiceExt;

const FIRST: &str = "\u{feff}野外笔记\r\n鸟鸣  \n";
const SECOND: &str = "附录原件\r\n";
const NEXT: &str = "修改后的正文\r\n";
const RUNNER_TOKEN: &str = "local-runner-integration-credential-for-tests";

struct Fixture {
    root: TempDir,
    app: Router,
    writer: String,
    reader: String,
    workspace: String,
    first: String,
    second: String,
    hidden: String,
}

impl Fixture {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for username in ["writer", "reader"] {
            users
                .create_user(
                    username,
                    "test-operation-password",
                    false,
                    Profile::default(),
                )
                .unwrap();
        }
        let writer = users.create_token("writer", "test").unwrap();
        let reader = users.create_token("reader", "test").unwrap();
        for (space, docs) in [
            ("field", vec![("First.md", FIRST), ("Second.md", SECOND)]),
            ("sealed", vec![("Sealed.md", "另一个工作区")]),
        ] {
            let folder = root.path().join("spaces").join(space);
            fs::create_dir_all(&folder).unwrap();
            for (name, body) in docs {
                fs::write(folder.join(name), body).unwrap();
            }
        }
        fs::write(root.path().join("spaces.json"), json!({
            "field": {"name":"Field","binding":{"prefix":"/field"},"access":"none","revisions":"managed",
                      "revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300},
                      "members":{"writer":{"role":"write"},"reader":{"role":"read"}}},
            "sealed": {"name":"Sealed","binding":{"prefix":"/sealed"},"access":"none","revisions":"managed",
                       "members":{"writer":{"role":"write"}}}
        }).to_string()).unwrap();
        let controls = root.path().join(".librarian");
        fs::create_dir(&controls).unwrap();
        fs::write(
            controls.join("runner-token.sha256"),
            sha256_hex(RUNNER_TOKEN.as_bytes()),
        )
        .unwrap();
        let product = librarian::Product::open(root.path(), 0).unwrap();
        product
            .manager()
            .instance("field")
            .unwrap()
            .revisions
            .as_ref()
            .unwrap()
            .snapshot_now()
            .unwrap();
        let app = product.router();
        let spaces = ok(&app, &writer, "GET", "/workspaces", Value::Null).await;
        let ws = |name| {
            string(
                spaces
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|workspace| workspace["name"] == name)
                    .unwrap(),
                "id",
            )
        };
        let workspace = ws("Field");
        let documents = ok(
            &app,
            &writer,
            "GET",
            &format!("/workspaces/{workspace}/documents"),
            Value::Null,
        )
        .await;
        let document = |name| {
            string(
                documents
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|document| document["path"] == name)
                    .unwrap(),
                "id",
            )
        };
        let sealed = ok(
            &app,
            &writer,
            "GET",
            &format!("/workspaces/{}/documents", ws("Sealed")),
            Value::Null,
        )
        .await;
        Self {
            root,
            app,
            writer,
            reader,
            workspace,
            first: document("First.md"),
            second: document("Second.md"),
            hidden: string(&sealed[0], "id"),
        }
    }

    async fn start(&self, account: &str, mode: &str) -> (String, String) {
        let (status, operation) = request(
            &self.app, account, "POST", "/ai/operations",
            json!({"workspaceId":self.workspace,"documentId":self.first,"mode":mode,"prompt":"阅读这两份文档。"}),
        ).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{operation}");
        assert_eq!(operation["status"], "queued");
        let operation_id = string(&operation, "id");
        let claimed = ok(
            &self.app,
            RUNNER_TOKEN,
            "POST",
            "/ai/runner/claims",
            json!({}),
        )
        .await;
        assert_eq!(claimed["operationId"], operation_id);
        (operation_id, string(&claimed, "leaseId"))
    }

    async fn source(&self, lease: &str, document: &str) -> Value {
        ok(
            &self.app,
            RUNNER_TOKEN,
            "POST",
            &format!("/ai/runner/claims/{lease}/sources"),
            json!({"documentId":document}),
        )
        .await
    }

    async fn result(&self, lease: &str, result: Value) -> (StatusCode, Value) {
        request(
            &self.app,
            RUNNER_TOKEN,
            "PUT",
            &format!("/ai/runner/claims/{lease}/result"),
            result,
        )
        .await
    }

    async fn operation(&self, token: &str, id: &str) -> Value {
        ok(
            &self.app,
            token,
            "GET",
            &format!("/ai/operations/{id}"),
            Value::Null,
        )
        .await
    }

    fn repo(&self) -> PathBuf {
        self.root.path().join("spaces/field")
    }

    fn git(&self, args: &[&str]) -> String {
        let result = Command::new("git")
            .arg("-C")
            .arg(self.repo())
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap()
    }

    async fn save_human_edit(&self, before: &str) {
        ok(
            &self.app,
            &self.writer,
            "PUT",
            &format!("/documents/{}", self.first),
            json!({"markdown":"人工修改","baseRevision":sha256_hex(before.as_bytes())}),
        )
        .await;
    }
}

fn string(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("Missing {key} in {value}"))
        .to_owned()
}

async fn request(
    app: &Router,
    token: &str,
    method: &str,
    path: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let result = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/api/v1{path}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = result.into_parts();
    let bytes = to_bytes(body, 1_000_000).await.unwrap();
    (parts.status, serde_json::from_slice(&bytes).unwrap())
}

async fn ok(app: &Router, token: &str, method: &str, path: &str, payload: Value) -> Value {
    let (status, response) = request(app, token, method, path, payload).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {response}");
    response
}

fn edit(path: &str, before: &str, after: Option<&str>) -> Value {
    json!({"path":path,"baseRevision":sha256_hex(before.as_bytes()),"markdown":after})
}

#[tokio::test]
async fn read_only_chat_creates_no_revision() {
    let f = Fixture::open().await;
    let original = f.git(&["rev-parse", "HEAD"]);
    let (op, lease) = f.start(&f.reader, "chat").await;
    let source = f.source(&lease, &f.first).await;
    assert_eq!(source["markdown"], FIRST);
    let (status, result) = f
        .result(
            &lease,
            json!({"answer":"笔记记录了鸟鸣。","sourceIds":[source["source"]["id"]],"edits":[]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "succeeded");
    assert!(result["commitId"].is_null());
    assert_eq!(result["sources"][0]["documentId"], f.first);
    assert_eq!(f.operation(&f.reader, &op).await, result);
    assert_eq!(f.git(&["rev-parse", "HEAD"]), original);
}

#[tokio::test]
async fn normal_ai_write_creates_one_version_without_proposal() {
    let f = Fixture::open().await;
    let (op, lease) = f.start(&f.writer, "edit").await;
    let first = f.source(&lease, &f.first).await;
    let second = f.source(&lease, &f.second).await;
    let change = json!({
        "answer":"已更新正文和附录。",
        "sourceIds":[first["source"]["id"],second["source"]["id"]],
        "edits":[edit("First.md", FIRST, Some(NEXT)),edit("Second.md", SECOND, Some("新附录\r\n"))]
    });
    let (status, result) = f.result(&lease, change.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["sources"].as_array().unwrap().len(), 2);
    assert_eq!(result["commitId"], f.git(&["rev-parse", "HEAD"]).trim());
    assert_eq!(f.git(&["show", "HEAD:First.md"]), NEXT);
    assert_eq!(f.git(&["show", "HEAD:Second.md"]), "新附录\r\n");
    assert_eq!(
        f.result(&lease, change).await,
        (StatusCode::OK, result.clone())
    );
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "2\n");

    let undone = ok(
        &f.app,
        &f.writer,
        "POST",
        &format!("/ai/operations/{op}/undo"),
        json!({}),
    )
    .await;
    assert_ne!(undone["commitId"], result["commitId"]);
    assert_eq!(f.git(&["show", "HEAD:First.md"]), FIRST);
    assert_eq!(f.git(&["show", "HEAD:Second.md"]), SECOND);
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "3\n");
}

#[tokio::test]
async fn proposal_required_for_destructive_action() {
    let f = Fixture::open().await;
    let (op, lease) = f.start(&f.writer, "edit").await;
    let source = f.source(&lease, &f.first).await;
    let (status, result) = f
        .result(
            &lease,
            json!({
                "answer":"申请删除这份文档。","sourceIds":[source["source"]["id"]],
                "edits":[edit("First.md", FIRST, None)]
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["status"], "needs_confirmation");
    assert_eq!(
        fs::read_to_string(f.repo().join("First.md")).unwrap(),
        FIRST
    );
    let confirmation = json!({"confirmationId":result["confirmation"]["id"]});
    let endpoint = format!("/ai/operations/{op}/confirm");
    assert_eq!(
        request(&f.app, &f.reader, "POST", &endpoint, confirmation.clone())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let confirmed = ok(&f.app, &f.writer, "POST", &endpoint, confirmation).await;
    assert_eq!(confirmed["status"], "succeeded");
    assert!(!f.repo().join("First.md").exists());
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "2\n");
}

#[tokio::test]
async fn cannot_cite_unread_workspace_file() {
    let f = Fixture::open().await;
    let (_, lease) = f.start(&f.writer, "chat").await;
    let outside = request(
        &f.app,
        RUNNER_TOKEN,
        "POST",
        &format!("/ai/runner/claims/{lease}/sources"),
        json!({"documentId":f.hidden}),
    )
    .await;
    assert_eq!(outside.0, StatusCode::NOT_FOUND, "{}", outside.1);
    let (status, result) = f
        .result(
            &lease,
            json!({"answer":"我读了附录。","sourceIds":[f.second],"edits":[]}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{result}");
    assert_eq!(result["code"], "unverified_source");
}

#[tokio::test]
async fn stale_ai_operation_returns_conflict() {
    let f = Fixture::open().await;
    let (op, lease) = f.start(&f.writer, "edit").await;
    let source = f.source(&lease, &f.first).await;
    f.save_human_edit(FIRST).await;
    let (status, result) = f.result(&lease, json!({
        "answer":"完成修改。","sourceIds":[source["source"]["id"]],"edits":[edit("First.md", FIRST, Some(NEXT))]
    })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(f.operation(&f.writer, &op).await["status"], "conflict");
    assert_eq!(
        fs::read_to_string(f.repo().join("First.md")).unwrap(),
        "人工修改"
    );
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "1\n");
}

#[tokio::test]
async fn undo_after_concurrent_save_rejects() {
    let f = Fixture::open().await;
    let (op, lease) = f.start(&f.writer, "edit").await;
    let source = f.source(&lease, &f.first).await;
    assert_eq!(f.result(&lease, json!({
        "answer":"已修改。","sourceIds":[source["source"]["id"]],"edits":[edit("First.md", FIRST, Some(NEXT))]
    })).await.0, StatusCode::OK);
    f.save_human_edit(NEXT).await;
    let endpoint = format!("/ai/operations/{op}/undo");
    assert_eq!(
        request(&f.app, &f.writer, "POST", &endpoint, json!({}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read_to_string(f.repo().join("First.md")).unwrap(),
        "人工修改"
    );
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "2\n");
}
