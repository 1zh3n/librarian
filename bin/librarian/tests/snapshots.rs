use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderMap, Request, StatusCode},
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server_common::revision::sha256_hex;
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGINAL: &str = "\u{feff}---\r\ntitle: 第一稿\r\n---\r\n正文  \r\n";
const UPDATED: &str = "---\ntitle: 第二稿\n---\n新正文\n";
const OLD_ASSET: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10, 0, 255];
const NEW_ASSET: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10, 1, 128];

struct Fixture {
    app: Option<librarian::Product>,
    root: TempDir,
    writer: String,
    administrator: String,
    reader: String,
    outsider: String,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for account in ["writer", "reader", "outsider", "administrator"] {
            users
                .create_user(
                    account,
                    "snapshot-test-password",
                    account == "administrator",
                    Profile::default(),
                )
                .unwrap();
        }
        let writer = users.create_token("writer", "snapshot writer").unwrap();
        let administrator = users
            .create_token("administrator", "snapshot administrator")
            .unwrap();
        let reader = users.create_token("reader", "snapshot reader").unwrap();
        let outsider = users.create_token("outsider", "snapshot outsider").unwrap();
        let folder = root.path().join("spaces/field");
        fs::create_dir_all(folder.join("media")).unwrap();
        fs::write(folder.join("Notes.md"), ORIGINAL).unwrap();
        fs::write(folder.join("Hidden.md"), "unselected document").unwrap();
        fs::write(folder.join("media/chart.png"), OLD_ASSET).unwrap();
        fs::write(folder.join("media/hidden.png"), b"unselected attachment").unwrap();
        fs::write(
            folder.join("media/active.html"),
            b"<script>alert(1)</script>",
        )
        .unwrap();
        fs::write(
            root.path().join("spaces.json"),
            json!({
                "field": {
                    "name": "Field", "binding": {"prefix": "/field"}, "access": "none",
                    "members": {"writer": {"role": "write"}, "reader": {"role": "read"}},
                    "revisions": "managed", "revisionsCommit": {"quietSecs": 300, "maxIntervalSecs": 300}
                }
            })
            .to_string(),
        )
        .unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap();
        app.manager()
            .instance("field")
            .unwrap()
            .revisions
            .as_ref()
            .unwrap()
            .snapshot_now()
            .unwrap();
        Self {
            app: Some(app),
            root,
            writer,
            administrator,
            reader,
            outsider,
        }
    }

    fn repo(&self) -> PathBuf {
        self.root.path().join("spaces/field")
    }

    fn git(&self, args: &[&str]) -> String {
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
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn restart(&mut self) {
        drop(self.app.take());
        self.app = Some(librarian::Product::open(self.root.path(), 0).unwrap());
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = self
            .app
            .as_ref()
            .unwrap()
            .router()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 2_000_000).await.unwrap().to_vec();
        (parts.status, parts.headers, bytes)
    }

    async fn get_json(&self, path: &str, token: Option<&str>) -> Value {
        let (status, headers, bytes) = self.request("GET", path, token, Value::Null).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn scope(&self) -> (String, String, String) {
        let workspaces = self.get_json("/workspaces", Some(&self.writer)).await;
        let workspace = workspaces[0]["id"].as_str().unwrap().to_owned();
        let documents = self
            .get_json(
                &format!("/workspaces/{workspace}/documents"),
                Some(&self.writer),
            )
            .await;
        let id = |path| {
            documents
                .as_array()
                .unwrap()
                .iter()
                .find(|doc| doc["path"] == path)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        (workspace, id("Notes.md"), id("Hidden.md"))
    }

    async fn create(&self, workspace: &str, body: Value) -> String {
        let (status, headers, bytes) = self
            .request(
                "POST",
                &format!("/workspaces/{workspace}/snapshots"),
                Some(&self.writer),
                body,
            )
            .await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        let snapshot: Value = serde_json::from_slice(&bytes).unwrap();
        let id = snapshot["id"].as_str().unwrap();
        assert!(id.len() >= 32);
        assert_eq!(snapshot["url"], format!("/r/{id}"));
        format!("/snapshots/{id}")
    }

    async fn denied(&self, method: &str, path: &str, token: Option<&str>, status: StatusCode) {
        let (actual, headers, bytes) = self.request(method, path, token, Value::Null).await;
        assert_eq!(actual, status, "{}", String::from_utf8_lossy(&bytes));
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    }
}

#[tokio::test]
async fn current_tracks_the_document_and_release_preserves_selected_git_bytes_after_restart() {
    let mut f = Fixture::new();
    let (workspace, document, hidden) = f.scope().await;
    let original_commit = f.git(&["rev-parse", "HEAD"]);
    let current = f
        .create(
            &workspace,
            json!({
                "kind": "current", "documentIds": [document],
                "attachmentPaths": ["media/chart.png"]
            }),
        )
        .await;
    let release = f
        .create(
            &workspace,
            json!({
                "kind": "release", "audience": "share", "documentIds": [document],
                "attachmentPaths": ["media/chart.png"], "commitId": original_commit
            }),
        )
        .await;

    fs::write(f.repo().join("Notes.md"), UPDATED).unwrap();
    fs::write(f.repo().join("media/chart.png"), NEW_ASSET).unwrap();
    f.git(&["add", "--", "Notes.md", "media/chart.png"]);
    f.git(&[
        "-c",
        "user.name=Snapshot fixture",
        "-c",
        "user.email=snapshot@example.test",
        "commit",
        "-qm",
        "Update document and attachment",
    ]);
    f.restart();

    let latest = f.get_json(&current, Some(&f.reader)).await;
    assert_eq!(latest["workspaceId"], workspace);
    assert_eq!(latest["kind"], "current");
    assert_eq!(latest["audience"], "members");
    assert_eq!(latest["commitId"], Value::Null);
    assert_eq!(latest["document"]["id"], document);
    assert_eq!(latest["document"]["title"], "第二稿");
    assert_eq!(latest["document"]["markdown"], UPDATED);

    let pinned = f.get_json(&release, None).await;
    assert_eq!(pinned["kind"], "release");
    assert_eq!(pinned["audience"], "share");
    assert_eq!(pinned["commitId"], original_commit);
    assert_eq!(pinned["document"]["id"], document);
    assert_eq!(pinned["document"]["path"], "Notes.md");
    assert_eq!(pinned["document"]["title"], "第一稿");
    assert_eq!(pinned["document"]["markdown"], ORIGINAL);
    assert_ne!(
        pinned["document"]["revision"],
        latest["document"]["revision"]
    );
    assert_eq!(
        pinned["documents"],
        json!([{"id": document, "path": "Notes.md", "title": "第一稿"}])
    );
    assert_eq!(pinned["attachmentPaths"], json!(["media/chart.png"]));
    let id = release.rsplit('/').next().unwrap();
    assert_eq!(
        f.git(&[
            "rev-parse",
            &format!("refs/librarian/snapshots/{}", sha256_hex(id.as_bytes()))
        ]),
        original_commit
    );

    for (snapshot, token, expected) in [
        (&current, Some(f.reader.as_str()), NEW_ASSET),
        (&release, None, OLD_ASSET),
    ] {
        let (status, headers, bytes) = f
            .request(
                "GET",
                &format!("{snapshot}/assets/media/chart.png"),
                token,
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "image/png");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(bytes, expected);
        f.denied(
            "GET",
            &format!("{snapshot}?documentId={hidden}"),
            token,
            StatusCode::NOT_FOUND,
        )
        .await;
        f.denied(
            "GET",
            &format!("{snapshot}/assets/media/hidden.png"),
            token,
            StatusCode::NOT_FOUND,
        )
        .await;
    }
    let (status, _, bytes) = f
        .request(
            "POST",
            &format!("/workspaces/{workspace}/rename"),
            Some(&f.administrator),
            json!({
                "operationId": "2fa4b557-91ec-4037-99cd-07249ce7a125",
                "from": "Notes.md", "to": "Journal.md"
            }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let renamed = f.get_json(&current, Some(&f.reader)).await;
    assert_eq!(renamed["document"]["id"], document);
    assert_eq!(renamed["document"]["path"], "Journal.md");
    assert_eq!(renamed["document"]["markdown"], UPDATED);
    assert_eq!(
        f.get_json(&release, None).await["document"]["path"],
        "Notes.md"
    );

    let historical = f
        .create(
            &workspace,
            json!({
                "kind": "release", "audience": "share", "documentIds": [document],
                "attachmentPaths": ["media/chart.png"], "commitId": original_commit
            }),
        )
        .await;
    let historical = f.get_json(&historical, None).await;
    assert_eq!(historical["document"]["path"], "Notes.md");
    assert_eq!(historical["document"]["markdown"], ORIGINAL);
}

#[tokio::test]
async fn member_permissions_are_live_and_share_revocation_covers_direct_assets() {
    let f = Fixture::new();
    let (workspace, document, _) = f.scope().await;
    let create = |audience| {
        json!({
            "kind": "current", "audience": audience,
            "documentIds": [document], "attachmentPaths": ["media/chart.png", "media/active.html"]
        })
    };
    let members = f.create(&workspace, create("members")).await;
    let share = f.create(&workspace, create("share")).await;
    let asset = format!("{members}/assets/media/chart.png");
    f.get_json(&members, Some(&f.reader)).await;
    f.denied("GET", &members, None, StatusCode::UNAUTHORIZED)
        .await;
    f.denied("GET", &asset, None, StatusCode::UNAUTHORIZED)
        .await;
    f.denied("GET", &asset, Some(&f.outsider), StatusCode::NOT_FOUND)
        .await;
    let users = UserStore::open(f.root.path()).unwrap().unwrap();
    f.app
        .as_ref()
        .unwrap()
        .manager()
        .remove_member_everywhere("reader", users.usernames())
        .unwrap();
    f.denied("GET", &members, Some(&f.reader), StatusCode::NOT_FOUND)
        .await;
    f.denied("GET", &asset, Some(&f.reader), StatusCode::NOT_FOUND)
        .await;

    let download = format!("{share}/assets/media/active.html");
    let (status, headers, bytes) = f.request("GET", &download, None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment");
    assert_eq!(bytes, b"<script>alert(1)</script>");
    f.denied("DELETE", &share, Some(&f.outsider), StatusCode::NOT_FOUND)
        .await;

    let (status, _, _) = f
        .request("DELETE", &share, Some(&f.writer), Value::Null)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    f.denied("GET", &share, None, StatusCode::NOT_FOUND).await;
    f.denied("GET", &download, None, StatusCode::NOT_FOUND)
        .await;
}

#[tokio::test]
async fn expired_release_cannot_serve_metadata_or_assets_and_releases_its_git_ref() {
    let f = Fixture::new();
    let (workspace, document, _) = f.scope().await;
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 2;
    let release = f
        .create(
            &workspace,
            json!({
                "kind": "release", "audience": "share", "documentIds": [document],
                "attachmentPaths": ["media/chart.png"], "expiresAt": expiry
            }),
        )
        .await;
    assert_eq!(f.get_json(&release, None).await["expiresAt"], expiry);
    let permanent = f
        .create(
            &workspace,
            json!({
                "kind": "release", "audience": "share", "documentIds": [document]
            }),
        )
        .await;

    tokio::time::sleep(Duration::from_secs(2)).await;
    let asset = format!("{release}/assets/media/chart.png");
    tokio::join!(
        f.denied("GET", &release, None, StatusCode::NOT_FOUND),
        f.denied("GET", &asset, None, StatusCode::NOT_FOUND),
    );
    f.get_json(&permanent, None).await;
    let id = release.rsplit('/').next().unwrap();
    assert_eq!(
        f.git(&[
            "for-each-ref",
            &format!("refs/librarian/snapshots/{}", sha256_hex(id.as_bytes()))
        ]),
        ""
    );
    let permanent_id = permanent.rsplit('/').next().unwrap();
    assert!(!f
        .git(&[
            "for-each-ref",
            &format!(
                "refs/librarian/snapshots/{}",
                sha256_hex(permanent_id.as_bytes())
            )
        ])
        .is_empty());
}

#[tokio::test]
async fn release_without_commit_captures_current_selected_bytes_with_git_normalization() {
    let f = Fixture::new();
    let (workspace, document, _) = f.scope().await;
    fs::write(f.repo().join(".gitattributes"), "*.png text eol=lf\n").unwrap();
    fs::write(f.repo().join("Notes.md"), UPDATED).unwrap();
    fs::write(f.repo().join("media/chart.png"), NEW_ASSET).unwrap();
    fs::write(f.repo().join("Hidden.md"), "unselected update").unwrap();
    f.git(&["add", "--", "Hidden.md"]);

    let release = f
        .create(
            &workspace,
            json!({
                "kind": "release", "audience": "share", "documentIds": [document],
                "attachmentPaths": ["media/chart.png"]
            }),
        )
        .await;
    assert_eq!(
        f.get_json(&release, None).await["document"]["markdown"],
        UPDATED
    );
    let (status, _, bytes) = f
        .request(
            "GET",
            &format!("{release}/assets/media/chart.png"),
            None,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, NEW_ASSET);
    assert_eq!(f.git(&["show", "HEAD:Hidden.md"]), "unselected document");
    assert_eq!(f.git(&["show", ":Hidden.md"]), "unselected update");
}

#[tokio::test]
async fn temporary_workspace_removes_its_snapshot_while_promoted_workspace_keeps_its_release() {
    let mut f = Fixture::new();
    let ephemeral = temporary_release(&f, "Ephemeral delivery").await;
    let promoted = temporary_release(&f, "Promoted delivery").await;
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3;
    for (workspace, _, _) in [&ephemeral, &promoted] {
        let (status, _, bytes) = f
            .request(
                "PATCH",
                &format!("/workspaces/{workspace}"),
                Some(&f.writer),
                json!({"expiresAt": expires}),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
    }
    assert_eq!(f.get_json(&ephemeral.2, None).await["expiresAt"], expires);
    let (status, _, bytes) = f
        .request(
            "PATCH",
            &format!("/workspaces/{}", promoted.0),
            Some(&f.writer),
            json!({"retention": "persistent"}),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );

    tokio::time::sleep(Duration::from_secs(3)).await;
    f.restart();
    let expired_asset = format!("{}/assets/chart.png", ephemeral.2);
    tokio::join!(
        f.denied("GET", &ephemeral.2, None, StatusCode::NOT_FOUND),
        f.denied("GET", &expired_asset, None, StatusCode::NOT_FOUND),
    );
    assert!(
        !ephemeral.1.exists(),
        "expired temporary mirror still exists"
    );
    assert!(promoted.1.exists(), "promoted workspace mirror was removed");
    let release = f.get_json(&promoted.2, None).await;
    assert_eq!(release["expiresAt"], Value::Null);
    assert_eq!(release["document"]["markdown"], UPDATED);
    let (status, _, bytes) = f
        .request(
            "GET",
            &format!("{}/assets/chart.png", promoted.2),
            None,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, NEW_ASSET);
}

async fn temporary_release(f: &Fixture, name: &str) -> (String, PathBuf, String) {
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 300;
    let (status, _, bytes) = f
        .request(
            "POST",
            "/workspaces",
            Some(&f.writer),
            json!({
                "name": name, "origin": "delivery", "retention": "temporary", "expiresAt": expires
            }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let workspace = value["id"].as_str().unwrap().to_owned();
    let space = value["spaceId"].as_str().unwrap();
    let instance = f.app.as_ref().unwrap().manager().instance(space).unwrap();
    let folder = instance
        .revisions
        .as_ref()
        .unwrap()
        .store()
        .root()
        .to_path_buf();
    let (status, _, bytes) = f
        .request(
            "POST",
            &format!("/workspaces/{workspace}/documents"),
            Some(&f.writer),
            json!({"path": "Draft.md", "markdown": UPDATED, "baseRevision": null }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let document = body["document"]["id"].as_str().unwrap();
    fs::write(folder.join("chart.png"), NEW_ASSET).unwrap();
    let release = f
        .create(
            &workspace,
            json!({
                "kind": "release", "audience": "share", "documentIds": [document],
                "attachmentPaths": ["chart.png"]
            }),
        )
        .await;
    (workspace, folder, release)
}
