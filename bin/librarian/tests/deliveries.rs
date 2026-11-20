use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    process::Command,
};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;
use zip::{write::SimpleFileOptions, ZipWriter};

const FIRST: &str = "\u{feff}交付原稿\r\n含尾随空格  \n";
const NEXT: &str = "后续交付\r\n";
const IMAGE: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 255];

struct Fixture {
    root: TempDir,
    router: Router,
    user: String,
    workspace: String,
    other: String,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        users
            .create_user("owner", "delivery-test-password", true, Profile::default())
            .unwrap();
        let user = users.create_token("owner", "test").unwrap();
        for id in ["left", "right"] {
            let folder = root.path().join("spaces").join(id);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("Existing.md"), "原有 Workspace 文档\n").unwrap();
        }
        fs::write(root.path().join("spaces.json"), json!({
            "left":{"name":"Left","binding":{"prefix":"/left"},"access":"none","revisions":"managed",
                    "members":{"owner":{"role":"write"}},
                    "revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300}},
            "right":{"name":"Right","binding":{"prefix":"/right"},"access":"none","revisions":"managed",
                    "members":{"owner":{"role":"write"}}}
        }).to_string()).unwrap();
        let product = librarian::Product::open(root.path(), 0).unwrap();
        product
            .manager()
            .instance("left")
            .unwrap()
            .revisions
            .as_ref()
            .unwrap()
            .snapshot_now()
            .unwrap();
        let router = product.router();
        let (_, payload) = request(&router, &user, "GET", "/workspaces", Value::Null).await;
        let workspace = |name| {
            payload
                .as_array()
                .unwrap()
                .iter()
                .find(|workspace| workspace["name"] == name)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        Self {
            root,
            router,
            user,
            workspace: workspace("Left"),
            other: workspace("Right"),
        }
    }

    fn repo(&self) -> PathBuf {
        self.root.path().join("spaces/left")
    }

    fn git(&self, args: &[&str]) -> Vec<u8> {
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
        result.stdout
    }

    async fn deliver(&self, token: &str, payload: Value) -> (StatusCode, Value) {
        request(
            &self.router,
            token,
            "POST",
            &format!("/workspaces/{}/deliveries", self.workspace),
            payload,
        )
        .await
    }

    async fn token(&self) -> Value {
        let (status, result) = request(
            &self.router,
            &self.user,
            "POST",
            &format!("/workspaces/{}/delivery-tokens", self.workspace),
            json!({"name":"CI"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{result}");
        result
    }
}

async fn request(
    router: &Router,
    token: &str,
    method: &str,
    path: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let response = router
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
    let (head, body) = response.into_parts();
    let body = to_bytes(body, 1_000_000).await.unwrap();
    (
        head.status,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}

fn payload(version: &str, markdown: &str) -> Value {
    json!({
        "manifest":{"deliveryId":"project-docs","sourceName":"Project docs","version":version,"generatedAt":"2026-11-21T00:00:00Z"},
        "files":[
            {"path":"Intro.md","contentBase64":STANDARD.encode(markdown)},
            {"path":"media/photo.png","contentBase64":STANDARD.encode(IMAGE)},
        ]
    })
}

fn archive(entries: &[(&str, &[u8])]) -> Value {
    let mut file = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        file.start_file(*name, SimpleFileOptions::default())
            .unwrap();
        file.write_all(bytes).unwrap();
    }
    json!({
        "manifest":{"deliveryId":"archive","sourceName":"ZIP"},
        "archiveBase64":STANDARD.encode(file.finish().unwrap().into_inner()),
    })
}

#[tokio::test]
async fn same_delivery_retry_keeps_one_commit() {
    let f = Fixture::new().await;
    let request = payload("1", FIRST);
    let (status, first) = f.deliver(&f.user, request.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    assert_eq!(
        f.deliver(&f.user, request).await,
        (StatusCode::CREATED, first.clone())
    );
    assert_eq!(first["deliveryId"], "project-docs");
    assert_eq!(first["workspaceId"], f.workspace);
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), b"2\n");
    assert_eq!(
        f.git(&["show", "HEAD:deliveries/project-docs/Intro.md"]),
        FIRST.as_bytes()
    );
    assert_eq!(
        f.git(&["show", "HEAD:deliveries/project-docs/media/photo.png"]),
        IMAGE
    );
}

#[tokio::test]
async fn updated_release_preserves_previous_revision_and_manual_changes() {
    let f = Fixture::new().await;
    let (_, first) = f.deliver(&f.user, payload("1", FIRST)).await;
    let (status, next) = f.deliver(&f.user, payload("2", NEXT)).await;
    assert_eq!(status, StatusCode::CREATED, "{next}");
    assert_ne!(next["commitId"], first["commitId"]);
    let first_commit = first["commitId"].as_str().unwrap();
    assert_eq!(
        f.git(&[
            "show",
            &format!("{first_commit}:deliveries/project-docs/Intro.md")
        ]),
        FIRST.as_bytes()
    );
    assert_eq!(
        f.git(&["show", "HEAD:deliveries/project-docs/Intro.md"]),
        NEXT.as_bytes()
    );
    fs::write(
        f.repo().join("deliveries/project-docs/Intro.md"),
        "外部人工更新\r\n",
    )
    .unwrap();
    let (status, _) = f.deliver(&f.user, payload("3", "文件源再次更新")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        fs::read(f.repo().join("deliveries/project-docs/Intro.md")).unwrap(),
        "外部人工更新\r\n".as_bytes()
    );
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), b"3\n");
}

#[tokio::test]
async fn delivery_scope_cannot_cross_workspace_or_read() {
    let f = Fixture::new().await;
    let grant = f.token().await;
    let secret = grant["token"].as_str().unwrap();
    let (status, response) = f.deliver(secret, payload("1", FIRST)).await;
    assert_eq!(status, StatusCode::CREATED, "{response}");
    assert_eq!(
        request(&f.router, secret, "GET", "/workspaces", Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &f.router,
            secret,
            "GET",
            &format!("/workspaces/{}/deliveries", f.workspace),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &f.router,
            secret,
            "POST",
            &format!("/workspaces/{}/deliveries", f.other),
            payload("1", FIRST)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, _) = request(
        &f.router,
        &f.user,
        "DELETE",
        &format!(
            "/workspaces/{}/delivery-tokens/{}",
            f.workspace,
            grant["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        f.deliver(secret, payload("2", NEXT)).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rejects_unsafe_archive_paths_and_duplicate_names() {
    let f = Fixture::new().await;
    for entries in [
        vec![("../Escape.md", FIRST.as_bytes())],
        vec![
            ("Nested/A.md", FIRST.as_bytes()),
            ("nested/a.md", NEXT.as_bytes()),
        ],
        vec![
            ("Images/A.md", FIRST.as_bytes()),
            ("images/B.md", NEXT.as_bytes()),
        ],
        vec![
            ("Attachment", IMAGE),
            ("Attachment/Doc.md", FIRST.as_bytes()),
        ],
        vec![
            ("Café.md", FIRST.as_bytes()),
            ("Cafe\u{301}.md", NEXT.as_bytes()),
        ],
    ] {
        let (status, error) = f.deliver(&f.user, archive(&entries)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
        assert!(!f.repo().join("deliveries").exists());
    }
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), b"1\n");
}

#[tokio::test]
async fn oversized_archive_leaves_workspace_untouched() {
    let f = Fixture::new().await;
    let size = 4 * 1024 * 1024 + 1;
    let huge = vec![b'a'; size];
    let (status, response) = f.deliver(&f.user, archive(&[("Large.md", &huge)])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{response}");
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), b"1\n");
    assert!(!f.repo().join("deliveries").exists());
}

#[tokio::test]
async fn streamed_zip_matches_json_receipt_and_serves_exact_attachment() {
    let f = Fixture::new().await;
    let data = archive(&[("Intro.md", FIRST.as_bytes()), ("Insets/Photo.png", IMAGE)]);
    let zip = STANDARD
        .decode(data["archiveBase64"].as_str().unwrap())
        .unwrap();
    let response = f
        .router
        .clone()
        .oneshot(
            Request::post(format!(
                "/api/v1/workspaces/{}/deliveries?deliveryId=archive&sourceName=ZIP",
                f.workspace
            ))
            .header("authorization", format!("Bearer {}", f.user))
            .header("content-type", "application/zip")
            .body(Body::from(zip))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let receipt: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32_768).await.unwrap()).unwrap();
    assert_eq!(
        f.deliver(&f.user, data).await,
        (StatusCode::CREATED, receipt)
    );
    let asset = f
        .router
        .clone()
        .oneshot(
            Request::get(format!(
                "/api/v1/workspaces/{}/assets/deliveries/archive/Insets/Photo.png",
                f.workspace
            ))
            .header("authorization", format!("Bearer {}", f.user))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(asset.headers()["content-type"], "image/png");
    assert_eq!(
        to_bytes(asset.into_body(), 32_768).await.unwrap().as_ref(),
        IMAGE
    );
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), b"2\n");
}
