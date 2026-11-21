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
        for name in ["alice", "bob", "reader"] {
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
                    "members": {"alice": {"role": "write"}, "reader": {"role": "read"}},
                    "revisions": "managed",
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
        assert!(form.contains("href=\"/.auth/librarian/consent.css\""));
        let theme = self
            .client
            .get(format!("{}/.auth/librarian/consent.css", self.url))
            .send()
            .await
            .unwrap();
        assert_eq!(theme.status(), StatusCode::OK);
        assert_eq!(
            theme.headers()[header::CONTENT_TYPE],
            "text/css; charset=utf-8"
        );
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
            cookie: cookie.into(),
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

    async fn tool(&self, session: &Session, name: &str, arguments: Value) -> Value {
        let response = self
            .rpc(
                &session.access,
                "tools/call",
                json!({"name": name, "arguments": arguments}),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response: Value = response.json().await.unwrap();
        assert!(response.get("result").is_some(), "{response}");
        response["result"].clone()
    }

    async fn product_get(&self, session: &Session, path: &str) -> Value {
        let response = self
            .client
            .get(format!("{}/api/v1{path}", self.url))
            .header(header::COOKIE, &session.cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.json().await.unwrap()
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
    cookie: String,
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
        assert_eq!(allowed[0]["spaceId"], expected);
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
    let wait_for_match = async |query: &str, page: &str| {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let result = host.request(&caller, "left", search(query)).await.unwrap();
            assert_eq!(
                result.status,
                StatusCode::OK,
                "{}",
                String::from_utf8_lossy(&result.body)
            );
            let body: Value = serde_json::from_slice(&result.body).unwrap();
            if body["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|hit| hit["page"] == page)
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Index did not return {page}: {body}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    wait_for_match("鸟鸣", "Same").await;
    let created = server
        .write(
            &caller,
            "Indexed.md",
            "新录，水面微光。\n",
            (header::IF_NONE_MATCH, "*".into()),
        )
        .await;
    assert!(created.status.is_success());
    wait_for_match("微光", "Indexed").await;

    let external = "纸本文档，迟到的鹭鸟。\n";
    fs::write(server.root.path().join("spaces/left/External.md"), external).unwrap();
    wait_for_match("鹭鸟", "External").await;
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
async fn mcp_lists_only_product_tools_and_their_input_contracts() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let response = server.rpc(&session.access, "tools/list", json!({})).await;
    let tools: Value = response.json().await.unwrap();
    let tools = tools["result"]["tools"].as_array().unwrap();
    let expected: [(&str, bool, &[&str]); 13] = [
        ("workspace_list", true, &[]),
        ("workspace_publish", false, &["workspaceId", "delivery"]),
        (
            "publication_request",
            false,
            &[
                "workspaceId",
                "targetId",
                "commitId",
                "documentIds",
                "operationId",
            ],
        ),
        ("document_list", true, &["workspaceId"]),
        ("document_read", true, &["documentId"]),
        ("document_search", true, &["workspaceId", "query"]),
        (
            "document_create",
            false,
            &["workspaceId", "operationId", "path", "markdown"],
        ),
        (
            "document_update",
            false,
            &["documentId", "operationId", "baseRevision", "markdown"],
        ),
        ("document_outline_read", true, &["documentId"]),
        (
            "document_outline_update",
            false,
            &["documentId", "operationId", "baseRevision", "markdown"],
        ),
        ("revision_list", true, &["documentId"]),
        ("revision_diff", true, &["documentId", "commitId"]),
        (
            "revision_restore",
            false,
            &["documentId", "operationId", "baseRevision", "commitId"],
        ),
    ];
    assert_eq!(tools.len(), expected.len());
    for (name, read_only, required) in expected {
        let tool = tools.iter().find(|tool| tool["name"] == name).unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], read_only, "{name}");
        assert_eq!(tool["inputSchema"]["type"], "object", "{name}");
        assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{name}");
        assert_eq!(tool["inputSchema"]["required"], json!(required), "{name}");
        for property in required {
            assert!(
                tool["inputSchema"]["properties"].get(property).is_some(),
                "{name}.{property}"
            );
        }
    }
}

#[tokio::test]
async fn revoke_grant_mid_session_blocks_further_reads() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
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
    let workspace = &listed["result"]["structuredContent"]["workspaces"][0];
    let workspace_id = workspace["id"].as_str().unwrap();
    assert_eq!(workspace["spaceId"], "left");
    assert_eq!(workspace["name"], "Left");
    let documents = server
        .rpc(
            access,
            "tools/call",
            json!({"name": "document_list", "arguments": {"workspaceId": workspace_id}}),
        )
        .await;
    assert_eq!(documents.status(), StatusCode::OK);
    let documents: Value = documents.json().await.unwrap();
    let document = &documents["result"]["structuredContent"]["documents"][0]["id"];
    assert!(document.is_string(), "{documents}");
    let revoked = server
        .client
        .post(format!("{}/.auth/revoke", server.url))
        .form(&[("token", refresh), ("client_id", session.client.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::OK);
    for bearer in [&session.access, access] {
        let result = server
            .rpc(
                bearer,
                "tools/call",
                json!({"name": "document_read", "arguments": {"documentId": document}}),
            )
            .await;
        assert_eq!(result.status(), StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn mcp_reuses_product_ids_and_checks_live_workspace_membership() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let http_workspaces = server.product_get(&session, "/workspaces").await;
    let find = |native: &str| {
        http_workspaces
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["spaceId"] == native)
            .unwrap()["id"]
            .as_str()
            .unwrap()
    };
    let (left, right) = (find("left"), find("right"));
    let listed = server.tool(&session, "workspace_list", json!({})).await;
    let workspaces = listed["structuredContent"]["workspaces"]
        .as_array()
        .unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["id"], left);
    assert_ne!(left, "left");

    let list_path = |workspace| format!("/workspaces/{workspace}/documents");
    let http_docs = server.product_get(&session, &list_path(left)).await;
    let documents = server
        .tool(&session, "document_list", json!({"workspaceId": left}))
        .await;
    assert_eq!(documents["structuredContent"]["documents"], http_docs);
    let same = |documents: Value| {
        documents
            .as_array()
            .unwrap()
            .iter()
            .find(|document| document["path"] == "Same.md")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let document_id = same(http_docs);
    let other_id = same(server.product_get(&session, &list_path(right)).await);
    let read_args = json!({"documentId": document_id});
    let fresh = "\u{feff}清晨，河岸鸟鸣。\r\n引文在这里。  \r";
    fs::write(server.root.path().join("spaces/left/Same.md"), fresh).unwrap();
    let read = server
        .tool(&session, "document_read", read_args.clone())
        .await;
    assert_eq!(read["structuredContent"]["markdown"], fresh);
    assert_eq!(read["structuredContent"]["document"]["id"], document_id);

    for (tool, args) in [
        ("document_list", json!({"workspaceId": right})),
        (
            "document_search",
            json!({"workspaceId": right, "query": "Private"}),
        ),
        ("document_read", json!({"documentId": other_id})),
        (
            "document_update",
            json!({"documentId": other_id, "operationId": "b91c447e-3687-4421-8a47-8cedca187105", "baseRevision": "0".repeat(64), "markdown": "no"}),
        ),
    ] {
        let error = server.tool(&session, tool, args).await;
        assert_eq!(error["isError"], true, "{tool}: {error}");
        assert_eq!(error["structuredContent"]["code"], "not_found", "{error}");
    }

    let manager = server.app.manager();
    let mut config = manager.instance("left").unwrap().config.clone();
    config.members.get_mut("alice").unwrap().role =
        silverbullet_server::multi::config::MemberRole::Read;
    manager.update("left", config.clone()).unwrap();
    let still_readable = server
        .tool(&session, "document_read", read_args.clone())
        .await;
    assert_eq!(still_readable["structuredContent"]["markdown"], fresh);
    let write = server.tool(&session, "document_update", json!({"documentId": document_id, "operationId": "da277684-0f06-47e7-9ee9-5cc84cdc1aec", "baseRevision": read["structuredContent"]["revision"], "markdown": "no"})).await;
    assert_eq!(write["structuredContent"]["code"], "read_only", "{write}");
    config.members.remove("alice");
    manager.update("left", config).unwrap();
    let read = server.tool(&session, "document_read", read_args).await;
    assert_eq!(read["structuredContent"]["code"], "not_found", "{read}");
    let listed = server.tool(&session, "workspace_list", json!({})).await;
    assert_eq!(listed["structuredContent"]["workspaces"], json!([]));
}

#[tokio::test]
async fn mcp_read_only_member_can_grant_and_read_but_cannot_write() {
    let server = Server::boot().await;
    let session = server.connect("reader", "left").await;
    let result = server.tool(&session, "workspace_list", json!({})).await;
    let workspaces = result["structuredContent"]["workspaces"]
        .as_array()
        .unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["spaceId"], "left");
    assert_eq!(workspaces[0]["canWrite"], false);
    let workspace = &workspaces[0]["id"];
    let result = server
        .tool(&session, "document_list", json!({"workspaceId": workspace}))
        .await;
    let document = result["structuredContent"]["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|document| document["path"] == "Same.md")
        .unwrap();
    let document_id = &document["id"];
    let result = server
        .tool(
            &session,
            "document_read",
            json!({"documentId": document_id}),
        )
        .await;
    assert_eq!(result["structuredContent"]["markdown"], LEFT);
    let write = server
        .tool(
            &session,
            "document_update",
            json!({
                "documentId": document_id,
                "operationId": "cb45bd9b-605f-49ce-903f-12210a4c677e",
                "baseRevision": result["structuredContent"]["revision"],
                "markdown": "must not write"
            }),
        )
        .await;
    assert_eq!(write["isError"], true);
    assert_eq!(write["structuredContent"]["code"], "read_only");
    assert_eq!(
        fs::read(server.root.path().join("spaces/left/Same.md")).unwrap(),
        LEFT.as_bytes()
    );

    let caller = server.caller(&session);
    let host = server.app.space_host();
    assert!(host.spaces(&caller).is_empty());
    let native = host
        .request(
            &caller,
            "left",
            SpaceRequest {
                method: Method::GET,
                path_and_query: "/.fs/Same.md".into(),
                body: Vec::new(),
                headers: Vec::new(),
            },
        )
        .await;
    assert!(native.is_err());
}

#[tokio::test]
async fn mcp_workspace_publish_reuses_the_product_delivery_receipt() {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.tool(&session, "workspace_list", json!({})).await;
    let workspace = workspaces["structuredContent"]["workspaces"][0]["id"]
        .as_str()
        .unwrap();
    let args = json!({
        "workspaceId":workspace,
        "delivery":{
            "manifest":{"deliveryId":"mcp-docs","sourceName":"MCP client"},
            "files":[{"path":"Guide.md","contentBase64":STANDARD.encode(LEFT)}]
        }
    });
    let result = server
        .tool(&session, "workspace_publish", args.clone())
        .await;
    assert_ne!(result["isError"], true, "{result}");
    let receipt = &result["structuredContent"];
    assert_eq!(
        &server.tool(&session, "workspace_publish", args).await["structuredContent"],
        receipt
    );
    let listed = server
        .product_get(&session, &format!("/workspaces/{workspace}/deliveries"))
        .await;
    assert_eq!(&listed[0], receipt);
    assert_eq!(
        fs::read(
            server
                .root
                .path()
                .join("spaces/left/deliveries/mcp-docs/Guide.md")
        )
        .unwrap(),
        LEFT.as_bytes()
    );
}

#[tokio::test]
async fn mcp_publication_requires_separate_workspace_manager_confirmation() {
    let server = Server::boot().await;
    let editor = server.connect("alice", "left").await;
    let reader = server.connect("reader", "left").await;
    let workspaces = server.tool(&editor, "workspace_list", json!({})).await;
    let workspace = &workspaces["structuredContent"]["workspaces"][0]["id"];
    let document = server
        .tool(
            &editor,
            "document_create",
            json!({
                "workspaceId": workspace, "operationId": "0e57ea0d-1e50-4fbf-b071-e76bce261a5c",
                "path": "Publish.md", "markdown": "# Test publication\n"
            }),
        )
        .await;
    let revision = &document["structuredContent"];
    assert!(revision["commitId"].is_string(), "{document}");
    let target = tempfile::tempdir().unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .current_dir(target.path())
        .status()
        .unwrap()
        .success());
    fs::write(
        server
            .root
            .path()
            .join(".librarian/publication-targets.json"),
        json!({"targets": [{
            "id": "fixture", "label": "Publication fixture", "workspaceId": workspace,
            "repository": target.path(), "branch": "main", "contentPath": "content/articles",
            "template": "article.html", "baseUrl": "https://example.test",
        }]})
        .to_string(),
    )
    .unwrap();
    let operation = "eba19732-a682-48fb-b461-dcd32ced22d7";
    let args = json!({
        "workspaceId": workspace, "targetId": "fixture", "commitId": revision["commitId"],
        "documentIds": [revision["documentId"]], "operationId": operation,
    });
    let denied = server
        .tool(&reader, "publication_request", args.clone())
        .await;
    assert_eq!(denied["isError"], true);
    let mut attempted_confirmation = args.clone();
    attempted_confirmation["confirm"] = true.into();
    let denied = server
        .tool(&editor, "publication_request", attempted_confirmation)
        .await;
    assert_eq!(denied["isError"], true);
    let proposed = server
        .tool(&editor, "publication_request", args.clone())
        .await;
    let publication = &proposed["structuredContent"];
    assert_eq!(publication["id"], operation, "{proposed}");
    assert_eq!(publication["status"], "pending");
    assert_eq!(publication["documentIds"], args["documentIds"]);
    assert_eq!(
        server
            .product_get(&editor, &format!("/publications/{operation}"))
            .await,
        *publication
    );
    assert!(!target.path().join("refs/heads/main").exists());
}

#[tokio::test]
async fn mcp_writes_create_immediate_versions_and_retries_reuse_receipts() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.tool(&session, "workspace_list", json!({})).await;
    let workspace = &workspaces["structuredContent"]["workspaces"][0]["id"];
    let first = "\u{feff}岷江鹭鸟。\r\n最后一行  \r";
    let second = "更新：江流。\r\n";
    let create = json!({"workspaceId": workspace, "operationId": "0e57ea0d-1e50-4fbf-b071-e76bce261a5c", "path": "New.md", "markdown": first});
    let created = server
        .tool(&session, "document_create", create.clone())
        .await;
    assert_ne!(created["isError"], true, "{created}");
    let created = &created["structuredContent"];
    let document = &created["documentId"];
    assert!(document.is_string(), "{created}");
    let read_args = json!({"documentId": document});
    let head = &created["commitId"];
    let history = server
        .tool(&session, "revision_list", read_args.clone())
        .await;
    assert_eq!(
        history["structuredContent"]["revisions"][0]["commitId"],
        *head
    );
    let read = server
        .tool(&session, "document_read", read_args.clone())
        .await;
    assert_eq!(read["structuredContent"]["markdown"], first);
    assert_eq!(
        read["structuredContent"]["revision"],
        created["changes"][0]["revision"]
    );
    let update = json!({"documentId": document, "operationId": "1a8d9c91-6a1d-4c4d-98d6-f2602f1cac00", "baseRevision": read["structuredContent"]["revision"], "markdown": second});
    let updated = server
        .tool(&session, "document_update", update.clone())
        .await;
    assert_ne!(updated["isError"], true, "{updated}");
    let updated = &updated["structuredContent"];
    assert_ne!(&updated["commitId"], head);
    let retry = server.tool(&session, "document_create", create).await;
    assert_eq!(&retry["structuredContent"], created);
    let retry = server
        .tool(&session, "document_update", update.clone())
        .await;
    assert_eq!(&retry["structuredContent"], updated);
    let mut changed_retry = update.clone();
    changed_retry["markdown"] = json!("different request");
    let changed_retry = server
        .tool(&session, "document_update", changed_retry)
        .await;
    assert_eq!(
        changed_retry["structuredContent"]["code"],
        "operation_id_reused"
    );
    let history = server
        .tool(&session, "revision_list", read_args.clone())
        .await;
    let revisions = history["structuredContent"]["revisions"]
        .as_array()
        .unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0]["commitId"], updated["commitId"]);
    let diff = server
        .tool(
            &session,
            "revision_diff",
            json!({"documentId": document, "commitId": updated["commitId"]}),
        )
        .await;
    assert_eq!(diff["structuredContent"]["markdown"], second);
    assert!(diff["structuredContent"]["diff"]
        .as_str()
        .unwrap()
        .contains("岷江鹭鸟"));

    let mut stale = update.clone();
    stale["operationId"] = json!("a7bb3d84-c92a-465c-8860-46a33473cd34");
    stale["markdown"] = json!("stale");
    let conflict = server
        .tool(&session, "document_update", stale.clone())
        .await;
    assert_eq!(
        conflict["structuredContent"]["code"], "revision_conflict",
        "{conflict}"
    );
    assert_eq!(
        conflict["structuredContent"]["currentRevision"],
        updated["changes"][0]["revision"]
    );
    stale["force"] = json!(true);
    let forced = server.tool(&session, "document_update", stale).await;
    assert_eq!(
        forced["structuredContent"]["code"], "invalid_request",
        "{forced}"
    );

    let outline = "## 独立提纲\r\n";
    let outline_args = json!({"documentId": document, "operationId": "2257e20f-6903-4ebb-9896-6629cea03f00", "baseRevision": null, "markdown": outline});
    let outline_write = server
        .tool(&session, "document_outline_update", outline_args.clone())
        .await;
    assert_eq!(
        outline_write["structuredContent"]["changes"][0]["path"], "New.outline.md",
        "{outline_write}"
    );
    let retry = server
        .tool(&session, "document_outline_update", outline_args)
        .await;
    assert_eq!(
        retry["structuredContent"],
        outline_write["structuredContent"]
    );
    let outline_read = server
        .tool(&session, "document_outline_read", read_args.clone())
        .await;
    assert_eq!(outline_read["structuredContent"]["markdown"], outline);

    let restore = json!({"documentId": document, "operationId": "9b6bdb8c-c89d-4a1f-be11-14688426758a", "baseRevision": updated["changes"][0]["revision"], "commitId": head});
    let restored = server
        .tool(&session, "revision_restore", restore.clone())
        .await;
    assert_ne!(restored["isError"], true, "{restored}");
    let retry = server.tool(&session, "revision_restore", restore).await;
    assert_eq!(retry["structuredContent"], restored["structuredContent"]);
    let history = server.tool(&session, "revision_list", read_args).await;
    assert_eq!(
        history["structuredContent"]["revisions"][0]["commitId"],
        restored["structuredContent"]["commitId"]
    );
    assert_eq!(
        fs::read(server.root.path().join("spaces/left/New.md")).unwrap(),
        first.as_bytes()
    );
    assert_eq!(
        fs::read(server.root.path().join("spaces/left/New.outline.md")).unwrap(),
        outline.as_bytes()
    );
    let search = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let response = server
                .tool(
                    &session,
                    "document_search",
                    json!({"workspaceId": workspace, "query": "鹭鸟"}),
                )
                .await;
            if let Some(hits) = response["structuredContent"]["hits"].as_array() {
                if let Some(hit) = hits.iter().find(|hit| hit["document"]["id"] == *document) {
                    break hit.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("MCP search returned the current document");
    assert!(search["excerpt"].as_str().unwrap().contains("鹭鸟"));
}
