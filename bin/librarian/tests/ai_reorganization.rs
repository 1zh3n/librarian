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

const RUNNER: &str = "synthetic-workspace-test-runner";
const NOTE: &str = "\u{feff}笔记  \r\n";
const OUTLINE: &str = "## 提纲\r\n";
const PROJECT: &str = "[笔记](../Notes/Field.md)\n";

struct Space {
    root: TempDir,
    app: Router,
    admin: String,
    writer: String,
    reader: String,
    ws: String,
    note: String,
    project: String,
}

impl Space {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        let token = |name, admin| {
            users
                .create_user(name, "synthetic-test-password", admin, Profile::default())
                .unwrap();
            users.create_token(name, "test").unwrap()
        };
        let admin = token("owner", true);
        let writer = token("writer", false);
        let reader = token("reader", false);
        let repo = root.path().join("spaces/field");
        fs::create_dir_all(repo.join("Notes")).unwrap();
        fs::create_dir(repo.join("Projects")).unwrap();
        fs::write(repo.join("Notes/Field.md"), NOTE).unwrap();
        fs::write(repo.join("Notes/Field.outline.md"), OUTLINE).unwrap();
        fs::write(repo.join("Projects/Plan.md"), PROJECT).unwrap();
        fs::write(
            root.path().join("spaces.json"),
            json!({"field":{"name":"Field","binding":{"prefix":"/field"},
            "revisions":"managed","revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300},
            "members":{"writer":{"role":"write"},"reader":{"role":"read"}}}})
            .to_string(),
        )
        .unwrap();
        let private = root.path().join(".librarian");
        fs::create_dir(&private).unwrap();
        fs::write(
            private.join("runner-token.sha256"),
            sha256_hex(RUNNER.as_bytes()),
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
        let mut space = Self {
            root,
            app: product.router(),
            admin,
            writer,
            reader,
            ws: String::new(),
            note: String::new(),
            project: String::new(),
        };
        let (_, spaces) = space
            .call(&space.writer, "GET", "/workspaces", Value::Null)
            .await;
        space.ws = field(&spaces[0], "id");
        let (_, docs) = space
            .call(
                &space.writer,
                "GET",
                &format!("/workspaces/{}/documents", space.ws),
                Value::Null,
            )
            .await;
        let find = |path| {
            field(
                docs.as_array()
                    .unwrap()
                    .iter()
                    .find(|d| d["path"] == path)
                    .unwrap(),
                "id",
            )
        };
        space.note = find("Notes/Field.md");
        space.project = find("Projects/Plan.md");
        space
    }
    fn folder(&self) -> PathBuf {
        self.root.path().join("spaces/field")
    }
    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(self.folder())
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }
    async fn call(&self, user: &str, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header("authorization", format!("Bearer {user}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(req).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }
    async fn start(&self, user: &str, mode: &str) -> (String, String) {
        let (status, op) = self
            .call(
                user,
                "POST",
                "/ai/operations",
                json!({"workspaceId":self.ws,"mode":mode,"prompt":"整理工作区"}),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{op}");
        let (status, claim) = self
            .call(RUNNER, "POST", "/ai/runner/claims", json!({}))
            .await;
        assert_eq!(status, StatusCode::OK, "{claim}");
        assert_eq!(claim["operationId"], op["id"]);
        (field(&op, "id"), field(&claim, "leaseId"))
    }
    async fn source(&self, lease: &str, doc: &str) -> Value {
        let (status, source) = self
            .call(
                RUNNER,
                "POST",
                &format!("/ai/runner/claims/{lease}/sources"),
                json!({"documentId":doc}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{source}");
        source["source"].clone()
    }
    async fn result(&self, lease: &str, input: Value) -> (StatusCode, Value) {
        self.call(
            RUNNER,
            "PUT",
            &format!("/ai/runner/claims/{lease}/result"),
            input,
        )
        .await
    }
    async fn action(&self, user: &str, id: &str, action: &str, body: Value) -> (StatusCode, Value) {
        self.call(user, "POST", &format!("/ai/operations/{id}/{action}"), body)
            .await
    }
}

fn field(v: &Value, key: &str) -> String {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing {key}: {v}"))
        .into()
}
fn create() -> Value {
    json!({"path":"Index.md","baseRevision":null,"markdown":"汇总\r\n"})
}

#[tokio::test]
async fn workspace_chat_summarizes_without_git_write() {
    let s = Space::open().await;
    let before = s.git(&["rev-parse", "HEAD"]);
    let (_, lease) = s.start(&s.reader, "chat").await;
    let note = s.source(&lease, &s.note).await;
    let project = s.source(&lease, &s.project).await;
    let (status, result) = s
        .result(
            &lease,
            json!({"answer":"笔记和项目","sourceIds":[note["id"],project["id"]]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["sources"], json!([note, project]));
    assert_eq!(s.git(&["rev-parse", "HEAD"]), before);
}

#[tokio::test]
async fn creates_cited_index_and_updates_atomically() {
    let s = Space::open().await;
    let before = s.git(&["rev-parse", "HEAD"]);
    let (id, lease) = s.start(&s.writer, "edit").await;
    let note = s.source(&lease, &s.note).await;
    let project = s.source(&lease, &s.project).await;
    let input = json!({"answer":"已整理","sourceIds":[note["id"],project["id"]],
        "edits":[create(),{"documentId":s.note,"baseRevision":note["revision"],"markdown":"新笔记\r\n"}]});
    let (status, result) = s.result(&lease, input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["sources"], json!([note, project]));
    assert_eq!(result["writeResult"]["created"], 1);
    assert_eq!(result["writeResult"]["updated"], 1);
    let created = &result["writeResult"]["documents"][0];
    assert_eq!(created["path"], "Index.md");
    let new_id = field(created, "documentId");
    assert_eq!(
        created["readerPath"],
        format!("/workspaces/{}/documents/{new_id}", s.ws)
    );
    assert_eq!(s.git(&["rev-parse", "HEAD^"]), before);
    assert_eq!(s.result(&lease, input).await, (status, result));
    assert_eq!(
        s.action(&s.writer, &id, "undo", json!({})).await.0,
        StatusCode::OK
    );
    assert_eq!(
        fs::read(s.folder().join("Notes/Field.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert!(!s.folder().join("Index.md").exists());
}

#[tokio::test]
async fn one_stale_edit_rejects_the_batch() {
    let s = Space::open().await;
    let (_, lease) = s.start(&s.writer, "edit").await;
    let source = s.source(&lease, &s.note).await;
    fs::write(s.folder().join("Notes/Field.md"), "人工编辑").unwrap();
    let (status, result) = s
        .result(
            &lease,
            json!({"answer":"整理","edits":[create(),
        {"documentId":s.note,"baseRevision":source["revision"],"markdown":"过期更新"}]}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert!(!s.folder().join("Index.md").exists());
}

#[tokio::test]
async fn ordinary_batch_rejects_33_files() {
    let s = Space::open().await;
    let (_, lease) = s.start(&s.writer, "edit").await;
    let edits: Vec<_> = (0..33)
        .map(|i| json!({"path":format!("{i}.md"),"baseRevision":null,"markdown":"x"}))
        .collect();
    let (status, result) = s
        .result(&lease, json!({"answer":"批量创建","edits":edits}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{result}");
    assert!(!s.folder().join("0.md").exists());
}

async fn preview(s: &Space, user: &str, request: Value) -> (String, Value) {
    let (id, lease) = s.start(user, "edit").await;
    let (status, result) = s
        .result(&lease, json!({"answer":"请确认","reorganization":request}))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "needs_confirmation");
    (id, result["confirmation"].clone())
}
fn decision(confirmation: &Value) -> Value {
    json!({"confirmationId":confirmation["id"]})
}
fn move_tree() -> Value {
    json!({"kind":"move","from":"Notes","to":"Archive/Notes"})
}

#[tokio::test]
async fn move_preserves_ids_and_outline_and_can_be_reversed() {
    let mut s = Space::open().await;
    let folder = s.folder();
    fs::write(folder.join("Notes/map.png"), [0, 255, 2, 128]).unwrap();
    let (id, confirmation) = preview(&s, &s.admin, move_tree()).await;
    assert_eq!(confirmation["plan"]["changes"].as_array().unwrap().len(), 6);
    assert_eq!(
        confirmation["plan"]["pathLinks"][0],
        json!({"from":"Projects/Plan.md","to":"Notes/Field.md"})
    );
    assert_eq!(confirmation["plan"]["request"], move_tree());
    assert!(folder.join("Notes/Field.md").exists());
    let (status, result) = s
        .action(&s.admin, &id, "confirm", decision(&confirmation))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (_, current) = s
        .call(
            &s.writer,
            "GET",
            &format!("/documents/{}", s.note),
            Value::Null,
        )
        .await;
    assert_eq!(current["document"]["path"], "Archive/Notes/Field.md");
    assert_eq!(
        fs::read(folder.join("Archive/Notes/Field.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(
        s.action(&s.admin, &id, "confirm", decision(&confirmation))
            .await,
        (status, result.clone())
    );
    s.app = Router::new();
    s.app = librarian::Product::open(s.root.path(), 0).unwrap().router();
    let (status, undo) = s.action(&s.admin, &id, "undo", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{undo}");
    assert_ne!(undo["commitId"], result["commitId"]);
    assert_eq!(
        s.action(&s.admin, &id, "undo", json!({})).await,
        (status, undo)
    );
    let (_, current) = s
        .call(
            &s.writer,
            "GET",
            &format!("/documents/{}", s.note),
            Value::Null,
        )
        .await;
    assert_eq!(current["document"]["path"], "Notes/Field.md");
    assert_eq!(
        fs::read(folder.join("Notes/map.png")).unwrap(),
        [0, 255, 2, 128]
    );
    assert_eq!(
        fs::read(folder.join("Notes/Field.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(
        fs::read(folder.join("Projects/Plan.md")).unwrap(),
        PROJECT.as_bytes()
    );
}

#[tokio::test]
async fn confirmation_revalidates_preview_under_write_lock() {
    let s = Space::open().await;
    let (id, plan) = preview(&s, &s.admin, move_tree()).await;
    fs::write(s.folder().join("Notes/New.md"), "新增").unwrap();
    let (status, result) = s.action(&s.admin, &id, "confirm", decision(&plan)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert!(!s.folder().join("Archive").exists());
    assert_eq!(
        fs::read(s.folder().join("Notes/Field.md")).unwrap(),
        NOTE.as_bytes()
    );
    let (_, current) = s
        .call(
            &s.admin,
            "GET",
            &format!("/ai/operations/{id}"),
            Value::Null,
        )
        .await;
    assert_eq!(current["confirmation"], plan);
}

#[tokio::test]
async fn delete_requires_confirmation_and_restores_bytes() {
    let s = Space::open().await;
    let request = json!({"kind":"delete","documentIds":[s.note,s.project]});
    let (id, plan) = preview(&s, &s.writer, request.clone()).await;
    assert_eq!(plan["paths"].as_array().unwrap().len(), 3);
    assert_eq!(
        s.action(&s.writer, &id, "cancel", decision(&plan)).await.1["status"],
        "canceled"
    );
    assert_eq!(
        s.action(&s.writer, &id, "confirm", decision(&plan)).await.0,
        StatusCode::CONFLICT
    );
    assert!(s.folder().join("Notes/Field.md").exists());
    let (id, plan) = preview(&s, &s.writer, request).await;
    assert_eq!(
        s.action(&s.writer, &id, "confirm", decision(&plan)).await.1["status"],
        "succeeded"
    );
    assert!(!s.folder().join("Notes/Field.outline.md").exists());
    let (status, diff) = s
        .call(
            &s.writer,
            "GET",
            &format!("/ai/operations/{id}/diff?path=Notes/Field.outline.md"),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{diff}");
    assert!(field(&diff, "diff").contains("提纲"));
    assert_eq!(
        s.action(&s.writer, &id, "undo", json!({})).await.0,
        StatusCode::OK
    );
    assert_eq!(
        fs::read(s.folder().join("Notes/Field.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert_eq!(
        fs::read(s.folder().join("Notes/Field.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    let (_, current) = s
        .call(
            &s.writer,
            "GET",
            &format!("/documents/{}", s.note),
            Value::Null,
        )
        .await;
    assert_eq!(current["markdown"], NOTE);
}

#[tokio::test]
async fn move_requires_manager_and_rejects_occupied_target_or_stale_undo() {
    let s = Space::open().await;
    let (_, lease) = s.start(&s.writer, "edit").await;
    assert_eq!(
        s.result(
            &lease,
            json!({"answer":"移动","reorganization":move_tree()})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let req = json!({"kind":"move","from":"Notes/Field.md","to":"New.md"});
    let (id, plan) = preview(&s, &s.admin, req.clone()).await;
    fs::write(s.folder().join("New.md"), "占用").unwrap();
    assert_eq!(
        s.action(&s.admin, &id, "confirm", decision(&plan)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read(s.folder().join("New.md")).unwrap(),
        "占用".as_bytes()
    );
    let (id, plan) = preview(
        &s,
        &s.admin,
        json!({"kind":"move","from":"Notes/Field.md","to":"Other.md"}),
    )
    .await;
    assert_eq!(
        s.action(&s.admin, &id, "confirm", decision(&plan)).await.0,
        StatusCode::OK
    );
    fs::write(s.folder().join("Other.outline.md"), "人工修改").unwrap();
    assert_eq!(
        s.action(&s.admin, &id, "undo", json!({})).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read(s.folder().join("Other.outline.md")).unwrap(),
        "人工修改".as_bytes()
    );
    assert!(!s.folder().join("Notes/Field.md").exists());
}

#[tokio::test]
async fn committed_move_survives_mapping_failure_and_cannot_be_canceled() {
    let mut s = Space::open().await;
    let (id, plan) = preview(&s, &s.admin, move_tree()).await;
    let db = rusqlite::Connection::open(s.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_mapping BEFORE UPDATE OF path ON documents WHEN OLD.path != NEW.path BEGIN SELECT RAISE(FAIL,'simulated interruption'); END;").unwrap();
    let (status, result) = s.action(&s.admin, &id, "confirm", decision(&plan)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{result}");
    assert!(s.folder().join("Archive/Notes/Field.md").exists());
    assert_eq!(
        s.action(&s.admin, &id, "cancel", decision(&plan)).await.0,
        StatusCode::CONFLICT
    );
    let committed = s.git(&["rev-parse", "HEAD"]);
    db.execute_batch("DROP TRIGGER fail_mapping").unwrap();
    drop(db);
    s.app = Router::new();
    s.app = librarian::Product::open(s.root.path(), 0).unwrap().router();
    let (status, result) = s.action(&s.admin, &id, "confirm", decision(&plan)).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["commitId"], committed);
    let (_, snapshot) = s
        .call(
            &s.writer,
            "GET",
            &format!("/documents/{}", s.note),
            Value::Null,
        )
        .await;
    assert_eq!(snapshot["document"]["path"], "Archive/Notes/Field.md");
    assert_eq!(
        s.action(&s.admin, &id, "undo", json!({})).await.0,
        StatusCode::OK
    );
    assert_eq!(
        fs::read(s.folder().join("Notes/Field.md")).unwrap(),
        NOTE.as_bytes()
    );
}

#[tokio::test]
async fn confirmation_checks_current_manager_role_and_managed_versions() {
    let mut s = Space::open().await;
    let (id, plan) = preview(&s, &s.admin, move_tree()).await;
    let path = s.root.path().join("spaces.json");
    let mut registry: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    registry["field"]["members"]["owner"] = json!({"role":"write"});
    fs::write(&path, registry.to_string()).unwrap();
    s.app = Router::new();
    let users = UserStore::open(s.root.path()).unwrap().unwrap();
    users
        .create_user(
            "other-admin",
            "other-synthetic-password",
            true,
            Profile::default(),
        )
        .unwrap();
    users.set_admin("owner", false).unwrap();
    s.app = librarian::Product::open(s.root.path(), 0).unwrap().router();
    let (status, result) = s.action(&s.admin, &id, "confirm", decision(&plan)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    assert_eq!(result["code"], "workspace_manage_required");
    s.app = Router::new();
    users.set_admin("owner", true).unwrap();
    registry["field"]["revisions"] = json!("disabled");
    fs::write(&path, registry.to_string()).unwrap();
    s.app = librarian::Product::open(s.root.path(), 0).unwrap().router();
    assert!(s
        .action(&s.admin, &id, "confirm", decision(&plan))
        .await
        .0
        .is_client_error());
    assert_eq!(
        fs::read(s.folder().join("Notes/Field.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert!(!s.folder().join("Archive").exists());
}

#[tokio::test]
async fn delete_undo_protects_a_new_outline_created_after_confirmation() {
    let s = Space::open().await;
    let (id, plan) = preview(
        &s,
        &s.writer,
        json!({"kind":"delete","documentIds":[s.project]}),
    )
    .await;
    assert_eq!(
        s.action(&s.writer, &id, "confirm", decision(&plan)).await.0,
        StatusCode::OK
    );
    fs::create_dir_all(s.folder().join("Projects")).unwrap();
    fs::write(s.folder().join("Projects/Plan.outline.md"), "人工提纲").unwrap();
    assert_eq!(
        s.action(&s.writer, &id, "undo", json!({})).await.0,
        StatusCode::CONFLICT
    );
    assert!(!s.folder().join("Projects/Plan.md").exists());
}

#[tokio::test]
async fn move_refuses_a_different_stable_document_with_identical_bytes() {
    let s = Space::open().await;
    let (id, plan) = preview(&s, &s.admin, move_tree()).await;
    let (status, renamed) = s
        .call(
            &s.admin,
            "POST",
            &format!("/workspaces/{}/rename", s.ws),
            json!({
                "operationId":"8981c8f8-e0a7-4ff5-ab18-643c2586baba","from":"Notes","to":"Originals"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    fs::create_dir_all(s.folder().join("Notes")).unwrap();
    fs::write(s.folder().join("Notes/Field.md"), NOTE).unwrap();
    fs::write(s.folder().join("Notes/Field.outline.md"), OUTLINE).unwrap();
    let (status, result) = s.action(&s.admin, &id, "confirm", decision(&plan)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert!(!s.folder().join("Archive").exists());
}
