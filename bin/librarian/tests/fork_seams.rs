use std::{fs, time::Duration};

use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use silverbullet_server::auth::mcp::SCOPE;
use silverbullet_server::auth::oauth::challenge_for;
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server::revisions::read::{file_at, file_diff, file_history};
use silverbullet_server_mcp::{Authenticate, Caller, McpHost, SpaceRequest, SpaceResponse};
use tempfile::TempDir;
use tokio::{net::TcpListener, task::JoinHandle};

const PASSWORD: &str = "test-account-only-password";
const LEFT: &str = "清晨，河岸鸟鸣。\r\n";
const RIGHT: &str = "Private test space B.\n";

struct Server {
    root: TempDir,
    _task: ServerTask,
    app: librarian::Product,
    url: String,
    client: Client,
}

struct ServerTask(JoinHandle<()>);
impl Drop for ServerTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Server {
    async fn boot() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for name in ["alice", "bob"] {
            users
                .create_user(name, PASSWORD, false, Profile::default())
                .unwrap();
        }
        for (folder, text) in [("left", LEFT), ("right", RIGHT)] {
            let path = root.path().join("spaces").join(folder);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("Same.md"), text).unwrap();
            fs::write(
                path.join("Index.md"),
                "phase zero <script>neverEmbed()</script>\n",
            )
            .unwrap();
        }
        fs::write(
            root.path().join("spaces.json"),
            json!({
                "left": {
                    "name": "Left", "binding": {"prefix": "/left"}, "access": "none",
                    "members": {"alice": {"role": "write"}}, "revisions": "managed",
                    "shell": {"enabled": true}
                },
                "right": {
                    "name": "Right", "binding": {"prefix": "/right"}, "access": "none",
                    "members": {"alice": {"role": "write"}, "bob": {"role": "write"}},
                    "revisions": "managed"
                }
            })
            .to_string(),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let url = format!("http://{address}");
        fs::write(
            root.path().join("server.json"),
            json!({"primaryUrl": url, "serverName": "Librarian", "mcp": true}).to_string(),
        )
        .unwrap();
        let app = librarian::Product::open(root.path(), address.port()).unwrap();
        let router = app.router();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap();
        Self {
            root,
            _task: ServerTask(task),
            app,
            url,
            client,
        }
    }

    async fn connect(&self, user: &str, space: &str) -> Session {
        let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect_uri = format!("http://{}/callback", callback.local_addr().unwrap());
        let callback_task = tokio::spawn(async move {
            let router =
                axum::Router::new().route("/callback", axum::routing::get(|| async { "ok" }));
            axum::serve(callback, router).await.unwrap();
        });
        let _callback = ServerTask(callback_task);
        let registration = self
            .client
            .post(format!("{}/.auth/register", self.url))
            .json(&json!({
                "client_name": "Librarian loopback test",
                "redirect_uris": [redirect_uri],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(registration.status(), StatusCode::CREATED);
        let registration: Value = registration.json().await.unwrap();
        let client = registration["client_id"].as_str().unwrap();
        let verifier = "librarian-loopback-test-verifier-0123456789abcd";
        let mut authorize = Url::parse(&format!("{}/.auth/mcp/authorize", self.url)).unwrap();
        let resource = format!("{}/.mcp", self.url);
        let challenge = challenge_for(verifier);
        let fields = [
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", &redirect_uri),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("scope", SCOPE),
            ("resource", &resource),
            ("state", "test-state"),
        ];
        authorize.query_pairs_mut().extend_pairs(fields);
        let login = self.client.get(authorize.clone()).send().await.unwrap();
        assert!(login.status().is_redirection());
        let login = authorize
            .join(login.headers()[header::LOCATION].to_str().unwrap())
            .unwrap();
        assert_eq!(
            self.client
                .get(login.clone())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let credentials = [("username", user), ("password", PASSWORD)];
        assert_eq!(
            self.client
                .post(login.clone())
                .header(header::ORIGIN, "http://example.test")
                .form(&credentials)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let signed_in = self
            .client
            .post(login)
            .header(header::ORIGIN, &self.url)
            .form(&credentials)
            .send()
            .await
            .unwrap();
        assert_eq!(signed_in.status(), StatusCode::SEE_OTHER);
        let cookie = signed_in.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let consent = self
            .client
            .get(authorize.clone())
            .header(header::COOKIE, cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(consent.status(), StatusCode::OK);
        let form = consent.text().await.unwrap();
        let csrf = form
            .split_once("name=\"csrf_token\" value=\"")
            .unwrap()
            .1
            .split_once('"')
            .unwrap()
            .0;
        let mut decision = fields.to_vec();
        decision.extend([
            ("csrf_token", csrf),
            ("decision", "approve"),
            ("space", space),
        ]);
        let authorized = self
            .client
            .post(authorize)
            .header(header::COOKIE, cookie)
            .header(header::ORIGIN, &self.url)
            .form(&decision)
            .send()
            .await
            .unwrap();
        assert!(
            authorized.status().is_redirection(),
            "{}",
            authorized.text().await.unwrap_or_default()
        );
        let location =
            Url::parse(authorized.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(location.path(), "/callback");
        let pairs: std::collections::HashMap<_, _> = location.query_pairs().collect();
        assert_eq!(
            pairs.get("state").map(|value| value.as_ref()),
            Some("test-state")
        );
        assert_eq!(
            self.client
                .get(location.clone())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let tokens = self
            .client
            .post(format!("{}/.auth/mcp/token", self.url))
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client),
                ("code", pairs.get("code").unwrap().as_ref()),
                ("redirect_uri", &redirect_uri),
                ("code_verifier", verifier),
                ("resource", &resource),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(tokens.status(), StatusCode::OK);
        let tokens: Value = tokens.json().await.unwrap();
        Session {
            client: client.into(),
            access: tokens["access_token"].as_str().unwrap().into(),
            refresh: tokens["refresh_token"].as_str().unwrap().into(),
        }
    }

    async fn rpc(&self, token: &str, method: &str, params: Value) -> reqwest::Response {
        self.client
            .post(format!("{}/.mcp", self.url))
            .bearer_auth(token)
            .header(header::ACCEPT, "application/json, text/event-stream")
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
            .send()
            .await
            .unwrap()
    }

    fn caller(&self, session: &Session) -> Caller {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", session.access)).unwrap(),
        );
        self.app.space_host().authenticate(&headers).unwrap()
    }

    async fn file(&self, caller: &Caller, space: &str, path: &str) -> SpaceResponse {
        self.app
            .space_host()
            .request(
                caller,
                space,
                SpaceRequest {
                    method: Method::GET,
                    path_and_query: format!("/.fs/{path}"),
                    body: Vec::new(),
                    headers: vec![(header::ACCEPT, "application/octet-stream".into())],
                },
            )
            .await
            .unwrap()
    }

    async fn write(
        &self,
        caller: &Caller,
        path: &str,
        body: &str,
        condition: (header::HeaderName, String),
    ) -> SpaceResponse {
        self.app
            .space_host()
            .request(
                caller,
                "left",
                SpaceRequest {
                    method: Method::PUT,
                    path_and_query: format!("/.fs/{path}"),
                    body: body.as_bytes().to_vec(),
                    headers: vec![
                        condition,
                        (header::CONTENT_TYPE, "application/octet-stream".into()),
                    ],
                },
            )
            .await
            .unwrap()
    }
}

struct Session {
    client: String,
    access: String,
    refresh: String,
}

#[tokio::test]
async fn spaces_isolate_reads_and_grants() {
    let server = Server::boot().await;
    let alice = server.connect("alice", "left").await;
    let bob = server.connect("bob", "right").await;
    let left = server.caller(&alice);
    let right = server.caller(&bob);
    assert_eq!(
        server.file(&left, "left", "Same.md").await.body,
        LEFT.as_bytes()
    );
    assert_eq!(
        server.file(&right, "right", "Same.md").await.body,
        RIGHT.as_bytes()
    );
    for (caller, space) in [(&left, "right"), (&right, "left")] {
        let result = server
            .app
            .space_host()
            .request(
                caller,
                space,
                SpaceRequest {
                    method: Method::GET,
                    path_and_query: "/.fs/Same.md".into(),
                    body: vec![],
                    headers: vec![],
                },
            )
            .await;
        assert!(result.is_err());
    }
    for (session, expected) in [(&alice, "left"), (&bob, "right")] {
        let response = server
            .rpc(
                &session.access,
                "tools/call",
                json!({"name": "workspace_list"}),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value = response.json().await.unwrap();
        let allowed = result["result"]["structuredContent"]["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(allowed.len(), 1);
        assert_eq!(allowed[0]["id"], expected);
    }
    let public_read = server
        .client
        .get(format!("{}/left/.fs/Same.md", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(public_read.status(), StatusCode::NOT_FOUND);
    let deep = server
        .client
        .get(format!("{}/workspaces/left/documents/Index", server.url))
        .header(header::ACCEPT, "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(deep.status(), StatusCode::OK);
    let html = deep.text().await.unwrap();
    assert!(html.contains("<div id=\"root\"></div>"));
    assert!(!html.contains("neverEmbed"));
    for path in [
        "/.shell",
        "/left/.shell",
        "/left/.proxy/test",
        "/left/.runtime/eval",
    ] {
        let response = server
            .client
            .post(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn conditionals_reject_stale_and_allow_creation() {
    let server = Server::boot().await;
    let caller = server.caller(&server.connect("alice", "left").await);
    let created = server
        .write(
            &caller,
            "New.md",
            "第一次\r\n",
            (header::IF_NONE_MATCH, "*".into()),
        )
        .await;
    assert!(created.status.is_success());
    let duplicate = server
        .write(
            &caller,
            "New.md",
            "不可覆盖",
            (header::IF_NONE_MATCH, "*".into()),
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::PRECONDITION_FAILED);
    let etag = server.file(&caller, "left", "New.md").await.headers[header::ETAG]
        .to_str()
        .unwrap()
        .to_owned();
    let changed = server
        .write(
            &caller,
            "New.md",
            "第二次\r\n",
            (header::IF_MATCH, etag.clone()),
        )
        .await;
    assert!(changed.status.is_success());
    let stale = server
        .write(&caller, "New.md", "过期", (header::IF_MATCH, etag))
        .await;
    assert_eq!(stale.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(
        server.file(&caller, "left", "New.md").await.body,
        "第二次\r\n".as_bytes()
    );
}

#[tokio::test]
async fn git_history_reads_same_bytes_and_diff() {
    let server = Server::boot().await;
    let caller = server.caller(&server.connect("alice", "left").await);
    let instance = server.app.manager().instance("left").unwrap();
    let engine = instance.revisions.as_ref().unwrap();
    let store = engine.store();
    engine.snapshot_now().unwrap();
    let before = file_history(store, "Same.md", None, 5).unwrap().revisions;
    let base = &before[0].rev;
    let etag = server.file(&caller, "left", "Same.md").await.headers[header::ETAG]
        .to_str()
        .unwrap()
        .to_owned();
    let next = "入夜，银杏星光。\r\n";
    assert!(server
        .write(&caller, "Same.md", next, (header::IF_MATCH, etag))
        .await
        .status
        .is_success());
    engine.snapshot_now().unwrap();
    let after = file_history(store, "Same.md", None, 5).unwrap().revisions;
    assert_ne!(&after[0].rev, base);
    assert_eq!(
        file_at(store, "Same.md", base, false).unwrap().unwrap(),
        LEFT.as_bytes()
    );
    assert_eq!(
        file_at(store, "Same.md", &after[0].rev, false)
            .unwrap()
            .unwrap(),
        next.as_bytes()
    );
    let diff = file_diff(store, "Same.md", &after[0].rev, false)
        .unwrap()
        .unwrap();
    assert!(diff.contains("河岸鸟鸣") && diff.contains("银杏星光"));
}

#[tokio::test]
async fn search_finds_chinese_fixture() {
    let server = Server::boot().await;
    assert!(server.app.manager().search().model().is_none());
    let caller = server.caller(&server.connect("alice", "left").await);
    let search = |query: &str| SpaceRequest {
        method: Method::POST,
        path_and_query: "/.search/query".into(),
        body: json!({"query": query, "limit": 10})
            .to_string()
            .into_bytes(),
        headers: vec![
            (header::CONTENT_TYPE, "application/json".into()),
            (header::HeaderName::from_static("x-await-index"), "1".into()),
        ],
    };
    let host = server.app.space_host();
    let result = host.request(&caller, "left", search("鸟鸣")).await.unwrap();
    assert_eq!(
        result.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&result.body)
    );
    let text = String::from_utf8(result.body).unwrap();
    assert!(text.contains("Same"), "{text}");
    let created = server
        .write(
            &caller,
            "Indexed.md",
            "新录，水面微光。\n",
            (header::IF_NONE_MATCH, "*".into()),
        )
        .await;
    assert!(created.status.is_success());
    let result = host.request(&caller, "left", search("微光")).await.unwrap();
    let text = String::from_utf8(result.body).unwrap();
    assert!(text.contains("Indexed"), "{text}");

    let external = "纸本文档，迟到的鹭鸟。\n";
    fs::write(server.root.path().join("spaces/left/External.md"), external).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = host.request(&caller, "left", search("鹭鸟")).await.unwrap();
            if String::from_utf8_lossy(&result.body).contains("External") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("external disk write reached the live full-text index");
    let instance = server.app.manager().instance("left").unwrap();
    let engine = instance.revisions.as_ref().unwrap();
    engine.snapshot_now().unwrap();
    let store = engine.store();
    let history = file_history(store, "External.md", None, 1).unwrap();
    assert_eq!(
        file_at(store, "External.md", &history.revisions[0].rev, false)
            .unwrap()
            .unwrap(),
        external.as_bytes()
    );
}

#[tokio::test]
async fn mcp_lists_only_product_tools_and_revokes_grant() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let response = server.rpc(&session.access, "tools/list", json!({})).await;
    let tools: Value = response.json().await.unwrap();
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "workspace_list");
    assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
    let resource = format!("{}/.mcp", server.url);
    let refreshed = server
        .client
        .post(format!("{}/.auth/mcp/token", server.url))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", session.refresh.as_str()),
            ("client_id", session.client.as_str()),
            ("resource", resource.as_str()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: Value = refreshed.json().await.unwrap();
    let access = refreshed["access_token"].as_str().unwrap();
    let refresh = refreshed["refresh_token"].as_str().unwrap();
    assert_ne!(refresh, session.refresh);
    let connected = server
        .rpc(access, "tools/call", json!({"name": "workspace_list"}))
        .await;
    let listed: Value = connected.json().await.unwrap();
    assert_eq!(
        listed["result"]["structuredContent"]["workspaces"],
        json!([{"id":"left","name":"Left"}])
    );
    let revoked = server
        .client
        .post(format!("{}/.auth/revoke", server.url))
        .form(&[("token", refresh), ("client_id", session.client.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::OK);
    for bearer in [&session.access, access] {
        let result = server.rpc(bearer, "tools/list", json!({})).await;
        assert_eq!(result.status(), StatusCode::UNAUTHORIZED);
    }
}
