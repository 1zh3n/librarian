use std::{
    collections::VecDeque,
    fs,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json, Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tower::ServiceExt;

const KEY: &str = "sk-discovery-fixture-only";
const HOST: &str = "127.0.0.1:6947";
const ORIGIN: &str = "http://127.0.0.1:6947";

struct App {
    _root: TempDir,
    router: Router,
}

impl App {
    fn new(allowed: Option<&str>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for (name, admin) in [("admin", true), ("reader", false)] {
            users
                .create_user(name, "fixture-password", admin, Profile::default())
                .unwrap();
        }
        if let Some(allowed) = allowed {
            let dir = root.path().join(".librarian");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("ai-test-loopback"), allowed).unwrap();
        }
        let router = librarian::Product::open(root.path(), 6947)
            .unwrap()
            .router();
        Self {
            _root: root,
            router,
        }
    }

    async fn login(&self, account: &str) -> String {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::post("/.auth/librarian/login")
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::HOST, HOST)
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from(format!(
                        "username={account}&password=fixture-password"
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }

    async fn discover(&self, cookie: &str, origin: &str, input: Value) -> (StatusCode, Value) {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::post("/api/v1/ai/settings/discover")
                    .header(header::HOST, HOST)
                    .header(header::ORIGIN, origin)
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 512 * 1024).await.unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains(KEY),
            "credential echoed"
        );
        assert_eq!(parts.headers[header::CACHE_CONTROL], "no-store");
        (parts.status, serde_json::from_slice(&bytes).unwrap())
    }
}

fn draft(url: &str) -> Value {
    json!({"provider":"deepseek", "baseUrl":url, "apiKey":KEY})
}

struct Provider {
    addr: String,
    requests: Arc<Mutex<Vec<(String, bool)>>>,
}

impl Provider {
    async fn start(responses: Vec<Response>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let trace = requests.clone();
        let app = Router::new().fallback(move |req: Request<Body>| {
            let trace = trace.clone();
            let queue = queue.clone();
            async move {
                let authenticated = req
                    .headers()
                    .get(header::AUTHORIZATION)
                    .is_some_and(|h| h.as_bytes() == format!("Bearer {KEY}").as_bytes())
                    && !req.headers().contains_key(header::COOKIE);
                trace
                    .lock()
                    .unwrap()
                    .push((format!("{} {}", req.method(), req.uri()), authenticated));
                if req.uri().path() == "/slow/models" {
                    tokio::time::sleep(Duration::from_secs(20)).await;
                }
                queue
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(StatusCode::NOT_FOUND.into_response())
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { addr, requests }
    }

    fn base(&self) -> String {
        format!("http://{}", self.addr)
    }
}

#[tokio::test]
async fn discovers_models_and_effort_without_completions() {
    let catalog = |models: Value| Json(json!({"object":"list", "data":models})).into_response();
    let provider = Provider::start(vec![
        catalog(json!([{"id":"first", "effort":{"supported_levels":["careful"],"default_level":"careful"}}])),
        catalog(json!([
            {"id":"second","name":"新模型","context_window":100000,"max_output_tokens":12345,
             "input_modalities":["text","image"],"output_modalities":["text"],"internal":KEY,
             "effort":{"supported_levels":["quick","deep"],"default_level":"deep"}},
            {"id":"minimal"}
        ])),
    ]).await;
    let app = App::new(Some(&provider.addr));
    let admin = app.login("admin").await;
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let (status, first) = app.discover(&admin, ORIGIN, draft(&provider.base())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        first["models"],
        json!([{"id":"first","effort":{"supportedLevels":["careful"],"defaultLevel":"careful"}}])
    );
    let (status, second) = app
        .discover(&admin, ORIGIN, draft(&format!("{}/v1/", provider.base())))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        second["models"],
        json!([
            {"id":"second","name":"新模型","contextWindow":100000,"maxOutputTokens":12345,
             "inputModalities":["text","image"],"outputModalities":["text"],
             "effort":{"supportedLevels":["quick","deep"],"defaultLevel":"deep"}},
            {"id":"minimal"}
        ])
    );
    assert_eq!(second.as_object().unwrap().len(), 3);
    assert!(!second["discoveryId"].as_str().unwrap().is_empty());
    assert_ne!(first["discoveryId"], second["discoveryId"]);
    let after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!((before..=after).contains(&second["fetchedAt"].as_u64().unwrap()));
    assert_eq!(
        *provider.requests.lock().unwrap(),
        [
            ("GET /models".into(), true),
            ("GET /v1/models".into(), true)
        ]
    );
}

#[tokio::test]
async fn catalog_errors_are_actionable_and_redacted() {
    let target = Provider::start(vec![]).await;
    let upstream = Provider::start(vec![
        Json(json!({"data":[]})).into_response(),
        (StatusCode::UNAUTHORIZED, KEY).into_response(),
        (StatusCode::TOO_MANY_REQUESTS, KEY).into_response(),
        Redirect::temporary(&target.base()).into_response(),
        "x".repeat(256 * 1024 + 1).into_response(),
        format!("bad json {KEY}").into_response(),
        Json(json!({"data":[{"id":"abc","effort":{"supported_levels":"wrong"}}]})).into_response(),
        Json(json!({"data":[{"id":"abc","name":format!("Credential {KEY}")}]})).into_response(),
        (StatusCode::INTERNAL_SERVER_ERROR, KEY).into_response(),
    ])
    .await;
    let app = App::new(Some(&upstream.addr));
    let admin = app.login("admin").await;
    for (status, code) in [
        (502, "provider_empty_catalog"),
        (502, "provider_auth_failed"),
        (429, "provider_rate_limited"),
        (502, "provider_redirect"),
        (502, "provider_response_too_large"),
        (502, "provider_invalid_catalog"),
        (502, "provider_invalid_catalog"),
        (502, "provider_invalid_catalog"),
        (502, "provider_unavailable"),
    ] {
        let (actual, error) = app.discover(&admin, ORIGIN, draft(&upstream.base())).await;
        assert_eq!(actual.as_u16(), status);
        assert_eq!(error["code"], code);
        assert_eq!(error.as_object().unwrap().len(), 2);
    }
    let (status, error) = app
        .discover(&admin, ORIGIN, draft(&format!("{}/slow", upstream.base())))
        .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(error["code"], "provider_timeout");
    assert!(target.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn checks_browser_admin_origin_and_endpoint_before_contacting_provider() {
    let fixture = Provider::start(vec![]).await;
    let app = App::new(None);
    let admin = app.login("admin").await;
    let bearer = app
        .router
        .clone()
        .oneshot(
            Request::post("/api/v1/ai/settings/discover")
                .header(header::COOKIE, &admin)
                .header(header::AUTHORIZATION, "Bearer fixture-token")
                .header(header::ORIGIN, ORIGIN)
                .header(header::HOST, HOST)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(draft(&fixture.base()).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bearer.status(), StatusCode::UNAUTHORIZED);
    let error: Value =
        serde_json::from_slice(&to_bytes(bearer.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(error["code"], "browser_session_required");
    let reader = app.login("reader").await;
    for (cookie, origin, status, code) in [
        ("", ORIGIN, 401, "unauthorized"),
        (reader.as_str(), ORIGIN, 403, "account_admin_required"),
        (
            admin.as_str(),
            "https://other.example",
            403,
            "origin_mismatch",
        ),
    ] {
        let (actual, error) = app.discover(cookie, origin, draft(&fixture.base())).await;
        assert_eq!(actual.as_u16(), status);
        assert_eq!(error["code"], code);
    }
    for url in [
        fixture.base(),
        format!("https://{}", fixture.addr),
        "https://[::ffff:127.0.0.1]".into(),
        "https://localhost".into(),
        "http://api.deepseek.com".into(),
        "https://api.deepseek.com:0".into(),
        format!("https://admin:{KEY}@example.org"),
        format!("https://example.org/?key={KEY}"),
        "https://example.org/#fragment".into(),
    ] {
        let (actual, error) = app.discover(&admin, ORIGIN, draft(&url)).await;
        assert_eq!(actual.as_u16(), 422);
        assert_eq!(error["code"], "provider_address_rejected");
    }
    let allowed = App::new(Some(&fixture.addr));
    let cookie = allowed.login("admin").await;
    let other = Provider::start(vec![]).await;
    let (status, error) = allowed
        .discover(&cookie, ORIGIN, draft(&other.base()))
        .await;
    assert_eq!(status.as_u16(), 422);
    assert_eq!(error["code"], "provider_address_rejected");
    for body in [
        json!({"provider":"other","baseUrl":fixture.base(),"apiKey":KEY}),
        json!({"provider":"deepseek","baseUrl":fixture.base(),"apiKey":"   "}),
        json!({"provider":"deepseek","baseUrl":fixture.base(),"apiKey": ["invalid"]}),
    ] {
        let (status, error) = allowed.discover(&cookie, ORIGIN, body).await;
        assert_eq!(status.as_u16(), 422);
        assert_eq!(error["code"], "invalid_request");
    }
    assert!(other.requests.lock().unwrap().is_empty());
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[path = "ai_settings/configuration.rs"]
mod configuration;

#[tokio::test]
async fn saved_discovery_uses_only_the_connection_id() {
    let upstream = Provider::start(vec![
        Json(json!({"data":[{"id":"before"}]})).into_response(),
        Json(json!({"data":[{"id":"after"}]})).into_response(),
    ]).await;
    let app = App::new(Some(&upstream.addr));
    let admin = app.login("admin").await;
    let (_, discovery) = app.discover(&admin, ORIGIN, draft(&upstream.base())).await;
    let conn = json!({"provider":"deepseek","label":"fixture","baseUrl":upstream.base(),
        "discoveryId":discovery["discoveryId"],"keyChange":{"kind":"replace","apiKey":KEY}});
    let send = |method, path, conn: Value| app.router.clone().oneshot(
        Request::builder().method(method).uri(path).header(header::COOKIE, &admin)
        .header(header::HOST, HOST).header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE,"application/json").body(Body::from(conn.to_string())).unwrap());
    let created = send("POST","/api/v1/ai/settings/connections", conn.clone()).await.unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let list = send("GET","/api/v1/ai/settings",Value::Null).await.unwrap();
    let view: Value = serde_json::from_slice(&to_bytes(list.into_body(),65536).await.unwrap()).unwrap();
    let id = &view["connections"][0]["id"];
    let reader = app.login("reader").await;
    assert_eq!(app.discover(&reader,ORIGIN,json!({"connectionId":id})).await.0,StatusCode::FORBIDDEN);
    for field in ["apiKey","baseUrl","provider"] {
        let mixed = json!({"connectionId":id, field:"ignored"});
        assert_eq!(app.discover(&admin,ORIGIN,mixed).await.0,StatusCode::UNPROCESSABLE_ENTITY);
    }
    let (status, refreshed) = app.discover(&admin,ORIGIN,json!({"connectionId":id})).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(refreshed["models"],json!([{"id":"after"}]));
    let mut replacement = conn;
    replacement["discoveryId"] = refreshed["discoveryId"].clone();
    let rejected = send("POST","/api/v1/ai/settings/connections",replacement).await.unwrap();
    assert_eq!(rejected.status(),StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(*upstream.requests.lock().unwrap(),[("GET /models".into(),true),("GET /models".into(),true)]);
}
