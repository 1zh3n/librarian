use std::{borrow::Cow, sync::Arc};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use silverbullet_server::product::router::{build_product_router, ProductAsset, ProductState};
use tower::ServiceExt;

const SHELL: &[u8] = b"<!doctype html><html><body><div id=\"root\"></div></body></html>";

fn asset(path: &str) -> Option<ProductAsset> {
    (path == "index.html").then(|| ProductAsset {
        bytes: Cow::Borrowed(SHELL),
        content_type: "text/html; charset=utf-8".into(),
    })
}

fn app() -> axum::Router {
    build_product_router(Arc::new(ProductState {
        version: "test",
        asset,
    }))
}

async fn get(path: &str) -> axum::response::Response {
    app()
        .oneshot(
            Request::get(path)
                .header(header::HOST, "app.example.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

fn header<'a>(response: &'a axum::response::Response, name: &str) -> &'a str {
    response
        .headers()
        .get(name)
        .unwrap_or_else(|| panic!("missing {name}"))
        .to_str()
        .unwrap()
}

#[tokio::test]
async fn the_app_shell_carries_public_security_headers() {
    for path in [
        "/",
        "/ai",
        "/workspaces/field/documents/note",
        "/r/0123456789abcdef",
    ] {
        let response = get(path).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");

        let csp = header(&response, "content-security-policy");
        for directive in [
            "default-src 'self'",
            "script-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "frame-src 'none'",
        ] {
            assert!(csp.contains(directive), "{path} missing {directive}: {csp}");
        }
        assert!(
            csp.contains("img-src 'self' data: blob:"),
            "{path} must allow same-origin and local previews: {csp}"
        );
        assert!(
            csp.contains("connect-src 'self'"),
            "{path} must keep network access same-origin: {csp}"
        );

        assert_eq!(header(&response, "referrer-policy"), "no-referrer");
        assert_eq!(header(&response, "x-frame-options"), "DENY");
        assert_eq!(header(&response, "x-content-type-options"), "nosniff");
        assert_eq!(
            header(&response, "permissions-policy"),
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        );
    }
}

#[tokio::test]
async fn the_health_endpoint_is_not_the_app_shell() {
    let response = get("/api/v1/health").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers().get("content-security-policy").is_none(),
        "API responses should not inherit the shell CSP"
    );
}
