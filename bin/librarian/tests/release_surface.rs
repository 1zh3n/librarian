use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::Router;
use tower::ServiceExt;

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
    assert_eq!(home, deep);
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
    assert_eq!(home, deep);
    assert!(deep.contains("<div id=\"root\"></div>"));
    assert_eq!(get(&router, "/unknown").await.0, StatusCode::NOT_FOUND);
}
