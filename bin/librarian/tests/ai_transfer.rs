//! Exercise a global turn and the Reader decision against disposable workspaces.
use std::{collections::BTreeMap, fs, path::PathBuf};

use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

#[path = "fixtures/ai-materials/setup.rs"]
mod config;

const ORIGINAL: &[u8] = "原件  \r\n".as_bytes();
const CLAIMS: &str = "/ai/runner/v2/claims";

struct Site {
    root: TempDir,
    app: Router,
    tokens: BTreeMap<String, String>,
    source: String,
    target: String,
    doc: String,
}

impl Site {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        let mut tokens = BTreeMap::new();
        for user in ["admin", "copier", "former", "target-reader"] {
            users
                .create_sso_user(
                    user,
                    "test",
                    &format!("{user}@example.org"),
                    user == "admin",
                    Profile::default(),
                )
                .unwrap();
            tokens.insert(user.into(), users.create_token(user, "fixture").unwrap());
        }
        fs::create_dir_all(root.path().join("spaces/source/field")).unwrap();
        fs::create_dir_all(root.path().join("spaces/target/empty")).unwrap();
        fs::write(root.path().join("spaces/source/field/Note.md"), ORIGINAL).unwrap();
        fs::write(root.path().join("spaces.json"), json!({
            "source":{"name":"源空间","binding":{"prefix":"/source"},"access":"none","revisions":"managed","members":{"copier":{"role":"read"},"former":{"role":"read"}}},
            "target":{"name":"目标空间","binding":{"prefix":"/target"},"access":"none","revisions":"managed","members":{"copier":{"role":"write"},"target-reader":{"role":"read"}}}
        }).to_string()).unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap().router();
        config::configure(root.path()).unwrap();
        let mut f = Self {
            root,
            app,
            tokens,
            source: String::new(),
            target: String::new(),
            doc: String::new(),
        };
        let (_, spaces) = f.http("admin", "GET", "/workspaces", Value::Null).await;
        let ws = |name| {
            spaces
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["name"] == name)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        f.source = ws("源空间");
        f.target = ws("目标空间");
        let (_, docs) = f
            .http(
                "admin",
                "GET",
                &format!("/workspaces/{}/documents", f.source),
                Value::Null,
            )
            .await;
        f.doc = docs[0]["id"].as_str().unwrap().into();
        f
    }
    async fn http(&self, who: &str, method: &str, path: &str, data: Value) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header("content-type", "application/json");
        let token = if who == "runner" {
            req = req.header("x-librarian-runner-id", config::INSTANCE);
            config::RUNNER
        } else {
            &self.tokens[who]
        };
        let reply = self
            .app
            .clone()
            .oneshot(
                req.header("authorization", format!("Bearer {token}"))
                    .body(Body::from(data.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = reply.status().as_u16();
        let bytes = to_bytes(reply.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    fn files(&self, path: &str) -> PathBuf {
        self.root.path().join("spaces").join(path)
    }
    fn action(&self, kind: &str, folder: bool) -> Value {
        let mut a = json!({"kind":kind,"sourceWorkspaceId":self.source,"sourcePath":"field/Note.md","documentId":self.doc,"targetWorkspaceId":self.target,"targetPath":"empty/Copy.md"});
        if folder {
            a["sourcePath"] = "field".into();
            a["targetPath"] = "empty/field".into();
            a["sourceKind"] = "folder".into();
            a.as_object_mut().unwrap().remove("documentId");
        }
        a
    }
    async fn claim(&self, who: &str) -> String {
        let (status, conv) = self
            .http(who, "POST", "/ai/conversations", json!({"scope":"global"}))
            .await;
        assert_eq!(status, 201, "{conv}");
        let (status, turn) = self
            .http(
                who,
                "POST",
                &format!("/ai/conversations/{}/turns", conv["id"].as_str().unwrap()),
                json!({"prompt":"跨空间整理","clientTurnId":"request","mode":"edit"}),
            )
            .await;
        assert_eq!(status, 202, "{turn}");
        let (status, lease) = self.http("runner", "POST", CLAIMS, json!({})).await;
        assert_eq!(status, 200, "{lease}");
        format!("{CLAIMS}/{}/result", lease["leaseId"].as_str().unwrap())
    }
    async fn propose(&self, who: &str, action: Value) -> Value {
        let url = self.claim(who).await;
        let payload = json!({"answer":"请核对","sourceIds":[],"edits":[],"action":action});
        let (status, op) = self.http("runner", "PUT", &url, payload.clone()).await;
        assert_eq!(status, 200, "{op}");
        assert_eq!(op["status"], "needs_confirmation");
        assert_eq!(
            self.http("runner", "PUT", &url, payload).await,
            (200, op.clone())
        );
        op
    }
    async fn decide(&self, who: &str, verb: &str, op: &Value) -> (u16, Value) {
        self.http(
            who,
            "POST",
            &format!("/ai/operations/{}/{verb}", op["id"].as_str().unwrap()),
            json!({"confirmationId":op["confirmation"]["id"]}),
        )
        .await
    }
}

#[tokio::test]
async fn move_review_and_replay_preserve_the_old_document_link_with_new_permissions() {
    let f = Site::open().await;
    let op = f.propose("admin", f.action("move", false)).await;
    let preview = &op["confirmation"]["transfer"];
    assert_eq!(preview["sourceWorkspaceName"], "源空间");
    assert_eq!(preview["targetWorkspaceName"], "目标空间");
    assert_eq!(preview["fileCount"], 1);
    assert_eq!(
        preview["access"],
        json!({"gainedRead":1,"gainedWrite":0,"upgraded":1,"downgraded":0,"lost":1})
    );
    assert!(f.files("source/field/Note.md").is_file());
    assert!(!f.files("target/empty/Copy.md").exists());
    assert_eq!(f.decide("copier", "confirm", &op).await.0, 404);
    let (status, done) = f.decide("admin", "confirm", &op).await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["status"], "succeeded");
    assert_eq!(
        done["transferResult"],
        json!({"kind":"move","workspaceId":f.target,"workspaceName":"目标空间","path":"empty/Copy.md","documentId":f.doc})
    );
    assert_eq!(f.decide("admin", "confirm", &op).await, (200, done));
    let old = format!("/documents/{}", f.doc);
    let (status, current) = f.http("target-reader", "GET", &old, Value::Null).await;
    assert_eq!(status, 200, "{current}");
    assert_eq!(current["document"]["workspaceId"], f.target);
    assert_eq!(f.http("former", "GET", &old, Value::Null).await.0, 404);
    assert_eq!(fs::read(f.files("target/empty/Copy.md")).unwrap(), ORIGINAL);
    assert!(!f.files("source/field/Note.md").exists());
}

#[tokio::test]
async fn source_reader_copies_with_a_new_id_and_cannot_move_or_write_to_a_read_only_target() {
    let f = Site::open().await;
    for action in [f.action("move", false), {
        let mut a = f.action("copy", false);
        a["sourceWorkspaceId"] = f.target.clone().into();
        a["targetWorkspaceId"] = f.source.clone().into();
        a
    }] {
        let url = f.claim("copier").await;
        let (status, err) = f
            .http(
                "runner",
                "PUT",
                &url,
                json!({"answer":"","edits":[],"action":action}),
            )
            .await;
        assert_eq!(status, 403, "{err}");
        let fail = url.replace("/result", "/fail");
        assert_eq!(
            f.http("runner", "POST", &fail, json!({"text":"no access"}))
                .await
                .0,
            200
        );
    }
    let op = f.propose("copier", f.action("copy", false)).await;
    let (status, done) = f.decide("copier", "confirm", &op).await;
    assert_eq!(status, 200, "{done}");
    let id = done["transferResult"]["documentId"].as_str().unwrap();
    assert_ne!(id, f.doc);
    assert_eq!(
        f.decide("copier", "confirm", &op).await,
        (200, done.clone())
    );
    assert_eq!(
        f.http("former", "GET", &format!("/documents/{id}"), Value::Null)
            .await
            .0,
        404
    );
    assert_eq!(fs::read(f.files("source/field/Note.md")).unwrap(), ORIGINAL);
    assert_eq!(fs::read(f.files("target/empty/Copy.md")).unwrap(), ORIGINAL);
}

#[tokio::test]
async fn folder_conflict_or_cancel_keeps_the_files_and_the_reviewed_destination() {
    let f = Site::open().await;
    let op = f.propose("admin", f.action("copy", true)).await;
    fs::create_dir(f.files("target/empty/field")).unwrap();
    fs::write(f.files("target/empty/field/other.txt"), b"preserve").unwrap();
    assert_eq!(f.decide("admin", "confirm", &op).await.0, 409);
    let (_, current) = f
        .http(
            "admin",
            "GET",
            &format!("/ai/operations/{}", op["id"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(current["status"], "conflict");
    assert_eq!(current["confirmation"], op["confirmation"]);
    let (status, canceled) = f.decide("admin", "cancel", &op).await;
    assert_eq!(status, 200, "{canceled}");
    assert_eq!(canceled["status"], "canceled");
    assert_eq!(f.decide("admin", "confirm", &op).await.0, 409);
    assert!(!f.files("target/empty/field/Note.md").exists());
    assert_eq!(
        fs::read(f.files("target/empty/field/other.txt")).unwrap(),
        b"preserve"
    );
    assert_eq!(fs::read(f.files("source/field/Note.md")).unwrap(), ORIGINAL);
}

#[tokio::test]
async fn confirm_rechecks_the_actor_and_access_impact_after_restart() {
    for revoked in [true, false] {
        let mut f = Site::open().await;
        let op = f.propose("copier", f.action("copy", true)).await;
        let file = f.root.path().join("spaces.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        let member = if revoked { "copier" } else { "target-reader" };
        config["target"]["members"][member]["role"] = if revoked { "read" } else { "write" }.into();
        f.app = Router::new();
        fs::write(file, config.to_string()).unwrap();
        f.app = librarian::Product::open(f.root.path(), 0).unwrap().router();
        let (status, err) = f.decide("copier", "confirm", &op).await;
        assert_eq!(status, if revoked { 403 } else { 409 }, "{err}");
        assert!(f.files("source/field/Note.md").is_file());
        assert!(!f.files("target/empty/field").exists());
    }
}

#[tokio::test]
async fn directory_moves_or_copies_all_children_and_empty_directories_after_confirm() {
    for kind in ["copy", "move"] {
        let f = Site::open().await;
        fs::create_dir(f.files("source/field/empty-child")).unwrap();
        fs::write(f.files("source/field/二.txt"), b"two").unwrap();
        let op = f.propose("admin", f.action(kind, true)).await;
        assert_eq!(op["confirmation"]["transfer"]["fileCount"], 2);
        assert!(!f.files("target/empty/field").exists());
        let (status, done) = f.decide("admin", "confirm", &op).await;
        assert_eq!(status, 200, "{done}");
        assert!(done["transferResult"].get("documentId").is_none());
        assert!(f.files("target/empty/field/empty-child").is_dir());
        assert_eq!(
            fs::read(f.files("target/empty/field/二.txt")).unwrap(),
            b"two"
        );
        assert_eq!(
            fs::read(f.files("target/empty/field/Note.md")).unwrap(),
            ORIGINAL
        );
        let (_, docs) = f
            .http(
                "admin",
                "GET",
                &format!("/workspaces/{}/documents", f.target),
                Value::Null,
            )
            .await;
        assert_eq!(docs[0]["id"] == f.doc, kind == "move");
        assert_eq!(f.files("source/field").exists(), kind == "copy");
    }
}
