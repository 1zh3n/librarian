use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::Router;
use tower::ServiceExt;

#[test]
fn init_creates_a_first_administrator_and_preserves_existing_accounts() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let root = tempfile::tempdir().unwrap();
    let init = |password: &[u8]| {
        let mut process = Command::new(env!("CARGO_BIN_EXE_librarian"))
            .arg("--data-root")
            .arg(root.path())
            .args(["init", "--username", "owner"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        process.stdin.take().unwrap().write_all(password).unwrap();
        process.wait_with_output().unwrap()
    };
    assert!(!init(b"tiny\n").status.success());
    assert!(!root.path().join("users.json").exists());
    let first = init(b"release-test-password\n");
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let users_before = std::fs::read(root.path().join("users.json")).unwrap();
    let users = silverbullet_server::multi::users::UserStore::open(root.path())
        .unwrap()
        .unwrap();
    assert!(users.is_admin("owner"));
    let second = init(b"release-test-password\n");
    assert!(!second.status.success());
    assert_eq!(
        std::fs::read(root.path().join("users.json")).unwrap(),
        users_before
    );
}

fn without_noscript(html: &str) -> String {
    let Some(start) = html.find("<noscript>") else {
        return html.to_owned();
    };
    let Some(offset) = html[start..].find("</noscript>") else {
        return html.to_owned();
    };
    let end = start + offset + "</noscript>".len();
    format!("{}{}", &html[..start], &html[end..])
}

async fn get(router: &Router, path: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header(header::ACCEPT, "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 2_000_000).await.unwrap();
    (
        parts.status,
        parts.headers,
        String::from_utf8(bytes.to_vec()).unwrap(),
    )
}

#[tokio::test]
async fn serves_product_bundle_and_deep_link() {
    let router = librarian::router();
    let (status, headers, home) = get(&router, "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    assert!(home.contains("<title>Librarian</title>"));
    let (_, _, deep) = get(&router, "/workspaces/native/documents/doc-1").await;
    assert!(deep.contains("静态阅读版"));
    assert!(deep.contains("/workspaces/native/documents/doc-1/read"));
    assert_eq!(home, without_noscript(&deep));
    let (status, _, workspace_ai) = get(&router, "/workspaces/native/ai").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(home, workspace_ai);
    let script = home
        .split_once("src=\"/assets/")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(name, _)| name)
        .expect("Vite bundle entry");
    let (status, headers, javascript) = get(&router, &format!("/assets/{script}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert!(!javascript.is_empty());
    assert_eq!(
        get(&router, "/assets/missing.js").await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn api_404_is_json() {
    let router = librarian::router();
    let (status, headers, body) = get(&router, "/api/v1/unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["code"],
        "not_found"
    );
    let (status, headers, body) = get(&router, "/api/v1/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["version"],
        env!("CARGO_PKG_VERSION")
    );
}

#[tokio::test]
async fn product_excludes_runtime_shell_proxy() {
    let router = librarian::router();
    for path in [
        "/.shell",
        "/.proxy/content",
        "/.runtime/eval",
        "/.fs/Note.md",
        "/.lua",
        "/.plugs",
    ] {
        let (status, _, _) = get(&router, path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn bundle_skips_upstream_ssr() {
    let router = librarian::router();
    let (_, _, home) = get(&router, "/").await;
    let (status, _, deep) = get(&router, "/workspaces/native/documents/markdown-with-html").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(home, without_noscript(&deep));
    assert!(deep.contains("<div id=\"root\"></div>"));
    assert!(deep.contains("/workspaces/native/documents/markdown-with-html/read"));
    let (status, _, snapshot) = get(&router, "/r/reading-link").await;
    assert_eq!(status, StatusCode::OK);
    assert!(snapshot.contains("/r/reading-link/read"));
    assert_eq!(get(&router, "/unknown").await.0, StatusCode::NOT_FOUND);
}
