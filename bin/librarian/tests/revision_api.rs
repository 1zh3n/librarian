use std::{fs, path::PathBuf, process::Command, time::Duration};

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

    fn repo(&self) -> PathBuf {
        self.root.path().join("spaces/field")
    }

    fn git(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .arg("-C")
            .arg(self.repo())
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
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
async fn version_history_of_a_fresh_identical_document_excludes_the_source() {
    let f = Fixture::new("managed", 30);
    let source = f.document().await;
    let (_, original) = f.request("GET", &source, Value::Null).await;
    let unrelated = f.history(&source).await["revisions"][0]["commitId"].clone();
    f.save(&source, &original, NEXT).await;
    f.engine.as_ref().unwrap().snapshot_now().unwrap();
    let workspace = original["document"]["workspaceId"].as_str().unwrap();
    let (status, copy) = f
        .request(
            "POST",
            &format!("/workspaces/{workspace}/documents"),
            json!({"path":"Field copy.md", "markdown": NEXT,"baseRevision":null}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{copy}");
    f.engine.as_ref().unwrap().snapshot_now().unwrap();
    let doc = format!("/documents/{}", copy["document"]["id"].as_str().unwrap());
    let creation = f.history(&doc).await["revisions"][0]["commitId"].clone();
    let current = f.save(&doc, &copy, "independent edits").await;
    f.engine.as_ref().unwrap().snapshot_now().unwrap();
    let (_, first) = f
        .request("GET", &format!("{doc}/revisions?limit=1"), Value::Null)
        .await;
    assert_eq!(first["more"], true);
    let latest = first["revisions"][0]["commitId"].as_str().unwrap();
    let (_, second) = f
        .request(
            "GET",
            &format!("{doc}/revisions?limit=1&before={latest}"),
            Value::Null,
        )
        .await;
    assert_eq!(second["revisions"][0]["commitId"], creation);
    assert_eq!(second["more"], false);
    let oldest = creation.as_str().unwrap();
    let (_, past) = f
        .request(
            "GET",
            &format!("{doc}/revisions?before={oldest}"),
            Value::Null,
        )
        .await;
    assert_eq!(past["revisions"], json!([]));
    assert_eq!(
        f.history(&doc).await["revisions"].as_array().unwrap().len(),
        2
    );
    let foreign = unrelated.as_str().unwrap();
    assert_eq!(
        f.request(
            "GET",
            &format!("{doc}/revisions/{foreign}/diff"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(
            "POST",
            &format!("{doc}/restore"),
            json!({"baseRevision":current["revision"],"commitId":foreign})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fs::read(f.repo().join("Field copy.md")).unwrap(),
        b"independent edits"
    );
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

#[tokio::test]
async fn managed_versions_preserve_markdown_bytes_with_git_normalization() {
    for use_attributes in [false, true] {
        let f = Fixture::new("managed", 30);
        if use_attributes {
            fs::write(f.repo().join(".gitattributes"), "*.md text eol=lf\n").unwrap();
        } else {
            f.git(&["config", "--local", "core.autocrlf", "true"]);
        }
        let document = f.document().await;
        let (_, original) = f.request("GET", &document, Value::Null).await;
        let exact = "\u{feff}中文第一行\r\n第二行尾随空格  \r\n";
        let saved = f.save(&document, &original, exact).await;
        f.engine.as_ref().unwrap().commit_now();
        assert_eq!(f.git(&["show", "HEAD:Journal.md"]), exact.as_bytes());
        let previous = f.history(&document).await;
        assert_eq!(previous["uncommitted"], false);
        let target = previous["revisions"][0]["commitId"].as_str().unwrap();
        let unsnapshotted = "第三稿\r\n仍应完整恢复  \r\n";
        let next = f.save(&document, &saved, unsnapshotted).await;
        let (status, restored) = f
            .request(
                "POST",
                &format!("{document}/restore"),
                json!({"baseRevision":next["revision"],"commitId":target}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{restored}");
        assert_eq!(restored["snapshot"]["markdown"], exact);
        assert_eq!(
            fs::read(f.repo().join("Journal.md")).unwrap(),
            exact.as_bytes()
        );
        assert_eq!(f.git(&["show", "HEAD:Journal.md"]), exact.as_bytes());
        assert_eq!(
            f.git(&["show", "HEAD^:Journal.md"]),
            unsnapshotted.as_bytes()
        );
    }
}

#[tokio::test]
async fn failed_restore_leaves_head_body_and_index_unchanged() {
    for checkpoint_pending in [false, true] {
        let f = Fixture::new("managed", 30);
        let document = f.document().await;
        let (_, original) = f.request("GET", &document, Value::Null).await;
        let history = f.history(&document).await;
        let target = history["revisions"][0]["commitId"].as_str().unwrap();
        let saved = f.save(&document, &original, NEXT).await;
        if !checkpoint_pending {
            f.engine.as_ref().unwrap().commit_now();
        }

        let head = f.git(&["rev-parse", "HEAD"]);
        let index = fs::read(f.repo().join(".git/index")).unwrap();
        // Block publication of the commit after Git has already staged its paths.
        let branch = String::from_utf8(f.git(&["symbolic-ref", "HEAD"])).unwrap();
        let ref_lock = f
            .repo()
            .join(".git")
            .join(format!("{}.lock", branch.trim()));
        fs::write(&ref_lock, "").unwrap();
        let (status, failure) = f
            .request(
                "POST",
                &format!("{document}/restore"),
                json!({"baseRevision":saved["revision"],"commitId":target}),
            )
            .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failure}");
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(
            fs::read(f.repo().join("Journal.md")).unwrap(),
            NEXT.as_bytes()
        );
        assert_eq!(fs::read(f.repo().join(".git/index")).unwrap(), index);

        if checkpoint_pending {
            fs::remove_file(ref_lock).unwrap();
            f.engine.as_ref().unwrap().commit_now();
            assert_eq!(f.git(&["show", "HEAD:Journal.md"]), NEXT.as_bytes());
        }
    }
}

#[tokio::test]
async fn restore_leaves_unrelated_staged_files_in_the_index() {
    let f = Fixture::new("managed", 30);
    let document = f.document().await;
    let (_, original) = f.request("GET", &document, Value::Null).await;
    let history = f.history(&document).await;
    let target = history["revisions"][0]["commitId"].as_str().unwrap();
    let saved = f.save(&document, &original, NEXT).await;
    f.engine.as_ref().unwrap().commit_now();
    // The Space watcher ignores this dot file. It only belongs to the Git index.
    fs::write(f.repo().join(".staged-note"), "separately staged\n").unwrap();
    f.git(&["add", "--", ".staged-note"]);
    let (status, result) = f
        .request(
            "POST",
            &format!("{document}/restore"),
            json!({"baseRevision":saved["revision"],"commitId":target}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(f.git(&["show", "HEAD:Journal.md"]), ORIGINAL.as_bytes());
    assert_eq!(f.git(&["show", "HEAD^:Journal.md"]), NEXT.as_bytes());
    assert_eq!(
        f.git(&["ls-tree", "-r", "--name-only", "HEAD", "--", ".staged-note"]),
        b""
    );
    assert_eq!(
        f.git(&["diff", "--cached", "--name-only"]),
        b".staged-note\n"
    );
    assert_eq!(f.git(&["show", ":.staged-note"]), b"separately staged\n");
}
