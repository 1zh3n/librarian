use std::{fs, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::{
    multi::users::{Profile, UserStore},
    revisions::{file_at, file_history, RevisionEngine},
};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGINAL: &str = "\u{feff}第一稿\r\n\n原稿  \r";
const NEXT: &str = "第二稿\r\n原件仍保留尾随空格  \n";

struct Fixture {
    root: TempDir,
    app: Router,
    token: String,
    engine: Option<std::sync::Arc<RevisionEngine>>,
}

impl Fixture {
    fn new(mode: &str, quiet: u64) -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        users
            .create_user("writer", "history-test-password", false, Profile::default())
            .unwrap();
        let token = users.create_token("writer", "revision test").unwrap();
        let path = root.path().join("spaces/field");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("Journal.md"), ORIGINAL).unwrap();
        fs::write(
            root.path().join("spaces.json"),
            json!({
                "field": {"name":"Field","binding":{"prefix":"/field"},"access":"none",
                          "members":{"writer":{"role":"write"}},"revisions":mode,
                          "revisionsCommit":{"quietSecs":quiet,"maxIntervalSecs":300}}
            })
            .to_string(),
        )
        .unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap();
        let engine = app.manager().instance("field").unwrap().revisions.clone();
        if let Some(engine) = engine.as_ref() {
            engine.snapshot_now().unwrap();
        }
        Self {
            root,
            app: app.router(),
            token,
            engine,
        }
    }

    async fn request(&self, method: &str, path: &str, json: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header("authorization", format!("Bearer {}", self.token))
                    .header("content-type", "application/json")
                    .body(Body::from(json.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let body = to_bytes(body, 2_000_000).await.unwrap();
        (parts.status, serde_json::from_slice(&body).unwrap())
    }

    async fn document(&self) -> String {
        let (status, workspaces) = self.request("GET", "/workspaces", Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        let workspace = workspaces[0]["id"].as_str().unwrap();
        let (status, documents) = self
            .request(
                "GET",
                &format!("/workspaces/{workspace}/documents"),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        format!("/documents/{}", documents[0]["id"].as_str().unwrap())
    }

    async fn save(&self, document: &str, previous: &Value, markdown: &str) -> Value {
        let (status, snapshot) = self
            .request(
                "PUT",
                document,
                json!({"markdown":markdown,"baseRevision":previous["revision"]}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{snapshot}");
        snapshot
    }

    async fn history(&self, document: &str) -> Value {
        let (status, history) = self
            .request("GET", &format!("{document}/revisions"), Value::Null)
            .await;
        assert_eq!(status, StatusCode::OK, "{history}");
        history
    }
}

#[tokio::test]
async fn autosave_debounces_to_one_commit() {
    let f = Fixture::new("managed", 5);
    let document = f.document().await;
    let history = f.history(&document).await;
    assert_eq!(history["revisions"].as_array().unwrap().len(), 1);
    let (_, original) = f.request("GET", &document, Value::Null).await;
    let saved = f.save(&document, &original, NEXT).await;
    f.save(&document, &saved, "第三稿\r\n").await;
    let pending = f.history(&document).await;
    assert_eq!(pending["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(pending["uncommitted"], true);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    loop {
        let history = f.history(&document).await;
        let revisions = history["revisions"].as_array().unwrap();
        if revisions.len() > 1 {
            assert_eq!(revisions.len(), 2);
            assert_eq!(revisions[0]["author"], "writer");
            let store = f.engine.as_ref().unwrap().store();
            let commit = revisions[0]["commitId"].as_str().unwrap();
            assert_eq!(
                file_at(store, "Journal.md", commit, false)
                    .unwrap()
                    .unwrap(),
                "第三稿\r\n".as_bytes()
            );
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

#[tokio::test]
async fn history_diff_uses_requested_blob() {
    let f = Fixture::new("managed", 30);
    let document = f.document().await;
    let (_, old) = f.request("GET", &document, Value::Null).await;
    f.save(&document, &old, NEXT).await;
    f.engine.as_ref().unwrap().snapshot_now().unwrap();
    let history = f.history(&document).await;
    let latest = history["revisions"][0]["commitId"].as_str().unwrap();
    let original = history["revisions"][1]["commitId"].as_str().unwrap();
    for (commit, markdown) in [(latest, NEXT), (original, ORIGINAL)] {
        let (status, value) = f
            .request(
                "GET",
                &format!("{document}/revisions/{commit}/diff"),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["commitId"], commit);
        assert_eq!(value["markdown"], markdown);
        let diff = value["diff"].as_str().unwrap();
        assert!(diff.contains("Journal.md"));
    }
}

#[tokio::test]
async fn restore_adds_commit_and_rejects_stale_base() {
    let f = Fixture::new("managed", 30);
    let document = f.document().await;
    let (status, original) = f.request("GET", &document, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let history = f.history(&document).await;
    let target = history["revisions"][0]["commitId"].as_str().unwrap();
    let saved = f.save(&document, &original, NEXT).await;
    let endpoint = format!("{document}/restore");
    let request = |revision: &Value| json!({"baseRevision":revision,"commitId":target});
    let (status, conflict) = f
        .request("POST", &endpoint, request(&original["revision"]))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["currentRevision"], saved["revision"]);
    assert_eq!(
        fs::read(f.root.path().join("spaces/field/Journal.md")).unwrap(),
        NEXT.as_bytes()
    );
    assert_eq!(
        f.history(&document).await["revisions"],
        history["revisions"]
    );

    let (status, result) = f
        .request("POST", &endpoint, request(&saved["revision"]))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["snapshot"]["markdown"], ORIGINAL);
    let repo = f.engine.as_ref().unwrap().store();
    let entries = file_history(repo, "Journal.md", None, 5).unwrap().revisions;
    assert_eq!(entries.len(), 3);
    let restored = result["commitId"].as_str().unwrap();
    assert_eq!(entries[0].rev, restored);
    assert_eq!(entries[2].rev, target);
    assert_eq!(
        file_at(repo, "Journal.md", &entries[1].rev, false)
            .unwrap()
            .unwrap(),
        NEXT.as_bytes()
    );
    assert_eq!(
        file_at(repo, "Journal.md", restored, false)
            .unwrap()
            .unwrap(),
        ORIGINAL.as_bytes()
    );
    assert_eq!(
        fs::read(f.root.path().join("spaces/field/Journal.md")).unwrap(),
        ORIGINAL.as_bytes()
    );
}

#[tokio::test]
async fn revision_disabled_reports_unavailable() {
    let f = Fixture::new("disabled", 30);
    let document = f.document().await;
    let (status, unavailable) = f
        .request("GET", &format!("{document}/revisions"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(unavailable["code"], "revisions_disabled");
    let (_, previous) = f.request("GET", &document, Value::Null).await;
    assert_eq!(f.save(&document, &previous, NEXT).await["markdown"], NEXT);
}
