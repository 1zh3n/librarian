use std::{fs, time::Duration};

use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
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

#[path = "fixtures/mcp_workspace.rs"]
mod mcp_workspace;

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
        Self::with_reader_base(None).await
    }

    async fn with_reader_base(base: Option<&str>) -> Self {
        let root = tempfile::tempdir().unwrap();
        if let Some(base) = base {
            let dir = root.path().join(".librarian");
            fs::create_dir(&dir).unwrap();
            fs::write(
                dir.join("server.json"),
                json!({"publicReaderUrl":base}).to_string(),
            )
            .unwrap();
        }
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
    let expected: [(&str, bool, bool, &[&str]); 21] = [
        (
            "workspace_upload_files",
            false,
            true,
            &["workspaceId", "targetDirectory", "operationId", "files"],
        ),
        (
            "workspace_upload_image",
            false,
            true,
            &[
                "workspaceId",
                "operationId",
                "targetDirectory",
                "fileName",
                "contentBase64",
            ],
        ),
        (
            "workspace_read_asset",
            true,
            false,
            &["workspaceId", "path"],
        ),
        ("workspace_list_assets", true, false, &["workspaceId"]),
        (
            "workspace_apply_edits",
            false,
            true,
            &["workspaceId", "operationId", "edits"],
        ),
        (
            "workspace_request_reorganization",
            false,
            false,
            &["workspaceId", "operationId", "request"],
        ),
        (
            "workspace_get_operation",
            true,
            false,
            &["workspaceId", "operationId"],
        ),
        (
            "workspace_undo_operation",
            false,
            true,
            &["workspaceId", "operationId"],
        ),
        ("workspace_list", true, false, &[]),
        (
            "workspace_publish",
            false,
            true,
            &["workspaceId", "delivery"],
        ),
        (
            "publication_request",
            false,
            false,
            &[
                "workspaceId",
                "targetId",
                "commitId",
                "documentIds",
                "operationId",
            ],
        ),
        ("document_list", true, false, &["workspaceId"]),
        ("document_read", true, false, &["documentId"]),
        ("document_search", true, false, &["workspaceId", "query"]),
        (
            "document_create",
            false,
            false,
            &["workspaceId", "operationId", "path", "markdown"],
        ),
        (
            "document_update",
            false,
            true,
            &["documentId", "operationId", "baseRevision", "markdown"],
        ),
        ("document_outline_read", true, false, &["documentId"]),
        (
            "document_outline_update",
            false,
            true,
            &["documentId", "operationId", "baseRevision", "markdown"],
        ),
        ("revision_list", true, false, &["documentId"]),
        ("revision_diff", true, false, &["documentId", "commitId"]),
        (
            "revision_restore",
            false,
            true,
            &["documentId", "operationId", "baseRevision", "commitId"],
        ),
    ];
    assert_eq!(tools.len(), expected.len());
    for (name, read_only, destructive, required) in expected {
        let tool = tools.iter().find(|tool| tool["name"] == name).unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], read_only, "{name}");
        assert_eq!(
            tool["annotations"]["destructiveHint"], destructive,
            "{name}"
        );
        assert!(
            !(read_only && destructive),
            "{name} cannot be both read-only and destructive"
        );
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

#[tokio::test]
async fn mcp_uploads_reads_lists_and_undoes_an_image() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let png = include_bytes!("../../../server/testdata/images/tiny.png");
    let operation = "11111111-1111-4111-8111-111111111111";
    let uploaded = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": operation,
                "targetDirectory": "notes",
                "fileName": "tiny.png",
                "contentBase64": STANDARD.encode(png),
            }),
        )
        .await;
    let asset = &uploaded["structuredContent"];
    assert_eq!(asset["path"], "notes/tiny.png", "{uploaded}");
    assert_eq!(asset["contentType"], "image/png");
    assert_eq!(asset["width"], 2);
    assert_eq!(asset["height"], 3);
    let path = asset["path"].as_str().unwrap();

    let retried = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": operation,
                "targetDirectory": "notes",
                "fileName": "tiny.png",
                "contentBase64": STANDARD.encode(png),
            }),
        )
        .await;
    assert_eq!(retried["structuredContent"]["path"], "notes/tiny.png");
    assert_eq!(retried["structuredContent"]["commitId"], asset["commitId"]);

    let invalid = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": "44444444-4444-4444-8444-444444444444",
                "targetDirectory": "notes",
                "fileName": "broken.png",
                "contentBase64": STANDARD.encode(b"not an image"),
            }),
        )
        .await;
    assert_eq!(invalid["isError"], true);
    assert_eq!(invalid["structuredContent"]["code"], "invalid_image");

    let read = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": path}),
        )
        .await;
    assert_eq!(read["content"][0]["type"], "image");
    assert_eq!(read["content"][0]["mimeType"], "image/png");
    assert_eq!(read["structuredContent"]["inline"], true);
    assert_eq!(read["structuredContent"]["revision"], asset["revision"]);

    let replacement = STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        .unwrap();
    let replaced = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": "13131313-1313-4131-8131-131313131313",
                "targetDirectory": "notes",
                "fileName": "tiny.png",
                "contentBase64": STANDARD.encode(&replacement),
                "baseRevision": asset["revision"],
            }),
        )
        .await;
    assert_eq!(replaced["isError"], Value::Null, "{replaced}");
    assert_eq!(replaced["structuredContent"]["path"], path);
    assert_ne!(replaced["structuredContent"]["revision"], asset["revision"]);
    let read_replaced = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": path}),
        )
        .await;
    assert_eq!(
        STANDARD
            .decode(read_replaced["content"][0]["data"].as_str().unwrap())
            .unwrap(),
        replacement
    );
    let undone_replaced = server
        .tool(
            &session,
            "workspace_undo_operation",
            json!({
                "workspaceId": workspace,
                "operationId": "13131313-1313-4131-8131-131313131313",
            }),
        )
        .await;
    assert_eq!(undone_replaced["isError"], Value::Null, "{undone_replaced}");
    let read_original = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": path}),
        )
        .await;
    assert_eq!(
        STANDARD
            .decode(read_original["content"][0]["data"].as_str().unwrap())
            .unwrap(),
        png
    );

    let listed = server
        .tool(
            &session,
            "workspace_list_assets",
            json!({"workspaceId": workspace, "directory": "notes"}),
        )
        .await;
    assert_eq!(listed["structuredContent"]["assets"][0]["path"], path);
    assert_eq!(listed["structuredContent"]["assets"][0]["isImage"], true);
    assert_eq!(
        listed["structuredContent"]["assets"][0]["revision"],
        asset["revision"]
    );
    let root = server
        .tool(
            &session,
            "workspace_list_assets",
            json!({"workspaceId": workspace}),
        )
        .await;
    assert!(root["structuredContent"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .all(|asset| !asset["path"]
            .as_str()
            .unwrap()
            .to_ascii_lowercase()
            .ends_with(".md")));

    let uploaded = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": "55555555-5555-4555-8555-555555555555",
                "targetDirectory": "notes",
                "fileName": "zzz.png",
                "contentBase64": STANDARD.encode(png),
            }),
        )
        .await;
    assert_eq!(uploaded["isError"], Value::Null, "{uploaded}");
    let first_page = server
        .tool(
            &session,
            "workspace_list_assets",
            json!({"workspaceId": workspace, "directory": "notes", "limit": 1}),
        )
        .await;
    assert_eq!(
        first_page["structuredContent"]["assets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(first_page["structuredContent"]["hasMore"], true);
    let first_path = first_page["structuredContent"]["assets"][0]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let second_page = server
        .tool(
            &session,
            "workspace_list_assets",
            json!({
                "workspaceId": workspace,
                "directory": "notes",
                "after": first_path,
                "limit": 10,
            }),
        )
        .await;
    assert!(second_page["structuredContent"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .all(|asset| asset["path"].as_str().unwrap() > first_path.as_str()));
    let all = server
        .tool(
            &session,
            "workspace_list_assets",
            json!({"workspaceId": workspace, "directory": "notes", "limit": 500}),
        )
        .await;
    assert!(all["structuredContent"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .all(|asset| !asset["path"].as_str().unwrap().contains("/.")));

    let undone = server
        .tool(
            &session,
            "workspace_undo_operation",
            json!({"workspaceId": workspace, "operationId": operation}),
        )
        .await;
    assert_eq!(undone["isError"], Value::Null);
    let missing = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": path}),
        )
        .await;
    assert_eq!(missing["isError"], true);
}

#[tokio::test]
async fn mcp_upload_accepts_a_full_size_image_within_the_json_body_limit() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let mut png = include_bytes!("../../../server/testdata/images/tiny.png").to_vec();
    png.resize(12 * 1024 * 1024, 0);
    let result = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": "12121212-3434-4567-8899-121212121212",
                "targetDirectory": "notes",
                "fileName": "full.png",
                "contentBase64": STANDARD.encode(&png),
            }),
        )
        .await;
    assert_eq!(result["isError"], Value::Null, "{result}");
    assert_eq!(result["structuredContent"]["path"], "notes/full.png");
    assert_eq!(result["structuredContent"]["width"], 2);
    assert_eq!(result["structuredContent"]["size"], 12 * 1024 * 1024);

    let read = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": "notes/full.png"}),
        )
        .await;
    assert_eq!(read["isError"], Value::Null, "{read}");
    assert_eq!(read["structuredContent"]["inline"], false);
    assert_eq!(read["structuredContent"]["size"], 12 * 1024 * 1024);
    assert_eq!(read["content"][0]["type"], "text");

    fs::write(
        server.root.path().join("spaces/left/oversized.png"),
        vec![0u8; 12 * 1024 * 1024 + 1],
    )
    .unwrap();
    let oversized = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": "oversized.png"}),
        )
        .await;
    assert_eq!(oversized["isError"], true);
    assert_eq!(oversized["structuredContent"]["code"], "asset_too_large");
}

#[tokio::test]
async fn mcp_batch_upload_validates_images_and_keeps_svg_as_an_attachment() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let invalid = server
        .tool(
            &session,
            "workspace_upload_files",
            json!({
                "workspaceId": workspace,
                "operationId": "77777777-7777-4777-8777-777777777777",
                "targetDirectory": "notes",
                "files": [{
                    "path": "broken.png",
                    "contentBase64": STANDARD.encode(b"not an image"),
                }],
            }),
        )
        .await;
    assert_eq!(invalid["isError"], true, "{invalid}");
    assert_eq!(invalid["structuredContent"]["code"], "invalid_image");

    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
    let uploaded = server
        .tool(
            &session,
            "workspace_upload_files",
            json!({
                "workspaceId": workspace,
                "operationId": "88888888-8888-4888-8888-888888888888",
                "targetDirectory": "notes",
                "files": [{
                    "path": "icon.svg",
                    "contentBase64": STANDARD.encode(svg),
                }],
            }),
        )
        .await;
    assert_eq!(uploaded["isError"], Value::Null, "{uploaded}");
    let read = server
        .tool(
            &session,
            "workspace_read_asset",
            json!({"workspaceId": workspace, "path": "notes/icon.svg"}),
        )
        .await;
    assert_eq!(read["isError"], Value::Null, "{read}");
    assert_eq!(read["content"][0]["type"], "text");
    assert_eq!(read["structuredContent"]["isImage"], false);
    assert_eq!(read["structuredContent"]["inline"], false);
    assert_eq!(
        read["structuredContent"]["contentType"],
        "application/octet-stream"
    );

    let reused = server
        .tool(
            &session,
            "workspace_upload_image",
            json!({
                "workspaceId": workspace,
                "operationId": "88888888-8888-4888-8888-888888888888",
                "targetDirectory": "notes",
                "fileName": "other.png",
                "contentBase64": STANDARD.encode(include_bytes!("../../../server/testdata/images/tiny.png")),
            }),
        )
        .await;
    assert_eq!(reused["isError"], true, "{reused}");
    assert_eq!(reused["structuredContent"]["code"], "operation_id_reused");
}

fn multipart_image_body(
    boundary: &str,
    operation_id: &str,
    file_name: &str,
    image: &[u8],
) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in [
        ("operationId", operation_id),
        ("targetDirectory", "notes"),
        ("fileName", file_name),
    ] {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(image);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn multipart_upload_body(
    boundary: &str,
    fields: &[(&str, &str)],
    file_name: &str,
    content_type: &str,
    image: &[u8],
) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(image);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

async fn http_upload(
    server: &Server,
    session: &Session,
    workspace: &str,
    body: Vec<u8>,
    boundary: &str,
) -> reqwest::Response {
    server
        .client
        .post(format!(
            "{}/api/v1/workspaces/{workspace}/assets",
            server.url
        ))
        .header(header::COOKIE, &session.cookie)
        .header(header::ORIGIN, &server.url)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn http_upload_rejects_unsupported_mismatched_and_unsafe_images() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let boundary = "librarian-image-reject-boundary";
    let png = include_bytes!("../../../server/testdata/images/tiny.png");
    let cases = [
        (
            "drawing.svg",
            "notes",
            "image/svg+xml",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".as_slice(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_image_type",
        ),
        (
            "photo.jpg",
            "notes",
            "image/png",
            png.as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_image",
        ),
        (
            "broken.png",
            "notes",
            "image/png",
            b"not an image".as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_image",
        ),
        (
            "empty.png",
            "notes",
            "image/png",
            b"".as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_image",
        ),
        (
            "../escape.png",
            "notes",
            "image/png",
            png.as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_path",
        ),
        (
            "photo.png",
            "../assets",
            "image/png",
            png.as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_path",
        ),
        (
            ".hidden.png",
            "notes",
            "image/png",
            png.as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_path",
        ),
        (
            "photo.png",
            "notes/.hidden",
            "image/png",
            png.as_slice(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_path",
        ),
    ];
    for (index, (file_name, directory, content_type, bytes, status, code)) in
        cases.into_iter().enumerate()
    {
        let operation = format!("9{index:07}-1111-4111-8111-111111111111");
        let body = multipart_upload_body(
            boundary,
            &[
                ("operationId", &operation),
                ("targetDirectory", directory),
                ("fileName", file_name),
            ],
            file_name,
            content_type,
            bytes,
        );
        let response = http_upload(&server, &session, workspace, body, boundary).await;
        assert_eq!(response.status(), status, "{file_name}");
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["code"], code, "{file_name}: {error}");
    }
    assert!(!server.root.path().join("spaces/left/notes").exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let root = server.root.path().join("spaces/left");
        fs::create_dir_all(root.join("safe")).unwrap();
        symlink(root.join("safe"), root.join("link")).unwrap();
        let body = multipart_upload_body(
            boundary,
            &[
                ("operationId", "91919191-9191-4191-8191-919191919191"),
                ("targetDirectory", "link"),
                ("fileName", "escape.png"),
            ],
            "escape.png",
            "image/png",
            png,
        );
        let response = http_upload(&server, &session, workspace, body, boundary).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!root.join("safe/escape.png").exists());
    }
}

#[tokio::test]
async fn http_upload_replaces_an_exact_revision_and_invalidates_the_old_etag() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let boundary = "librarian-image-replace-boundary";
    let original = include_bytes!("../../../server/testdata/images/tiny.png");
    let replacement = STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        .unwrap();
    let upload = |operation: &str, base_revision: Option<&str>, bytes: &[u8]| {
        let mut fields = vec![
            ("operationId", operation),
            ("targetDirectory", "notes"),
            ("fileName", "replace.png"),
        ];
        if let Some(revision) = base_revision {
            fields.push(("baseRevision", revision));
        }
        multipart_upload_body(boundary, &fields, "replace.png", "image/png", bytes)
    };
    let first = http_upload(
        &server,
        &session,
        workspace,
        upload("aaaaaaaa-1111-4111-8111-111111111111", None, original),
        boundary,
    )
    .await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first: Value = first.json().await.unwrap();
    assert_eq!(first["path"], "notes/replace.png");
    let revision = first["revision"].as_str().unwrap().to_owned();
    let unicode_body = multipart_upload_body(
        boundary,
        &[
            ("operationId", "45454545-4545-4545-8545-454545454545"),
            ("targetDirectory", "notes"),
            ("fileName", "河岸 photo.png"),
        ],
        "河岸 photo.png",
        "image/png",
        original,
    );
    let unicode = http_upload(&server, &session, workspace, unicode_body, boundary).await;
    assert_eq!(unicode.status(), StatusCode::CREATED);
    let unicode: Value = unicode.json().await.unwrap();
    assert_eq!(unicode["path"], "notes/河岸 photo.png");
    assert_eq!(
        unicode["assetPath"],
        format!("/workspaces/{workspace}/assets/notes/%E6%B2%B3%E5%B2%B8%20photo.png")
    );
    let unicode_response = server
        .client
        .get(format!(
            "{}/api/v1{}",
            server.url,
            unicode["assetPath"].as_str().unwrap()
        ))
        .header(header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(unicode_response.status(), StatusCode::OK);
    assert_eq!(unicode_response.bytes().await.unwrap().as_ref(), original);

    let asset_url = format!(
        "{}/api/v1{}",
        server.url,
        first["assetPath"].as_str().unwrap()
    );
    let original_response = server
        .client
        .get(&asset_url)
        .header(header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    let old_etag = original_response.headers()[header::ETAG].clone();

    let replaced = http_upload(
        &server,
        &session,
        workspace,
        upload(
            "bbbbbbbb-2222-4222-8222-222222222222",
            Some(&revision),
            &replacement,
        ),
        boundary,
    )
    .await;
    assert_eq!(replaced.status(), StatusCode::CREATED);
    let replaced: Value = replaced.json().await.unwrap();
    assert_eq!(replaced["path"], "notes/replace.png");
    assert_ne!(replaced["revision"], revision);

    let retried = http_upload(
        &server,
        &session,
        workspace,
        upload(
            "bbbbbbbb-2222-4222-8222-222222222222",
            Some(&revision),
            &replacement,
        ),
        boundary,
    )
    .await;
    assert_eq!(retried.status(), StatusCode::CREATED);
    let retried: Value = retried.json().await.unwrap();
    assert_eq!(retried["path"], replaced["path"]);
    assert_eq!(retried["revision"], replaced["revision"]);
    assert_eq!(retried["commitId"], replaced["commitId"]);

    let reused = http_upload(
        &server,
        &session,
        workspace,
        upload(
            "bbbbbbbb-2222-4222-8222-222222222222",
            Some(&revision),
            original,
        ),
        boundary,
    )
    .await;
    assert_eq!(reused.status(), StatusCode::CONFLICT);
    let reused: Value = reused.json().await.unwrap();
    assert_eq!(reused["code"], "operation_id_reused");

    let stale = http_upload(
        &server,
        &session,
        workspace,
        upload(
            "cccccccc-3333-4333-8333-333333333333",
            Some(&revision),
            original,
        ),
        boundary,
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let stale: Value = stale.json().await.unwrap();
    assert_eq!(stale["code"], "asset_revision_conflict");

    let updated = server
        .client
        .get(&asset_url)
        .header(header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let new_etag = updated.headers()[header::ETAG].clone();
    assert_eq!(updated.bytes().await.unwrap().as_ref(), replacement);
    assert_ne!(new_etag, old_etag);
    let stale_revalidation = server
        .client
        .get(&asset_url)
        .header(header::COOKIE, &session.cookie)
        .header(header::IF_NONE_MATCH, old_etag)
        .send()
        .await
        .unwrap();
    assert_eq!(stale_revalidation.status(), StatusCode::OK);
    let current_revalidation = server
        .client
        .get(&asset_url)
        .header(header::COOKIE, &session.cookie)
        .header(header::IF_NONE_MATCH, new_etag)
        .send()
        .await
        .unwrap();
    assert_eq!(current_revalidation.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn http_upload_enforces_asset_limits_authorization_and_read_only_membership() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let reader = server.connect("reader", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let boundary = "librarian-image-limit-boundary";
    let fields = [
        ("operationId", "dddddddd-4444-4444-8444-444444444444"),
        ("targetDirectory", "notes"),
        ("fileName", "huge.png"),
    ];
    let mut huge = b"\x89PNG\r\n\x1a\n".to_vec();
    huge.resize(12 * 1024 * 1024 + 1, 0);
    let response = http_upload(
        &server,
        &session,
        workspace,
        multipart_upload_body(boundary, &fields, "huge.png", "image/png", &huge),
        boundary,
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["code"], "asset_too_large");

    let fields = [
        ("operationId", "eeeeeeee-5555-4555-8555-555555555555"),
        ("targetDirectory", "notes"),
        ("fileName", "reader.png"),
    ];
    let png = include_bytes!("../../../server/testdata/images/tiny.png");
    let response = http_upload(
        &server,
        &reader,
        workspace,
        multipart_upload_body(boundary, &fields, "reader.png", "image/png", png),
        boundary,
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["code"], "read_only");

    let response = server
        .client
        .post(format!(
            "{}/api/v1/workspaces/{workspace}/assets",
            server.url
        ))
        .header(header::ORIGIN, &server.url)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(multipart_upload_body(
            boundary,
            &fields,
            "reader.png",
            "image/png",
            png,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let fields = [
        ("operationId", "ffffffff-6666-4666-8666-666666666666"),
        ("targetDirectory", "notes"),
        ("fileName", "visible.png"),
    ];
    let visible = http_upload(
        &server,
        &session,
        workspace,
        multipart_upload_body(boundary, &fields, "visible.png", "image/png", png),
        boundary,
    )
    .await;
    assert_eq!(visible.status(), StatusCode::CREATED);
    let visible: Value = visible.json().await.unwrap();
    let visible_url = format!(
        "{}/api/v1{}",
        server.url,
        visible["assetPath"].as_str().unwrap()
    );
    let anonymous = server.client.get(&visible_url).send().await.unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let readable = server
        .client
        .get(&visible_url)
        .header(header::COOKIE, &reader.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(readable.status(), StatusCode::OK);

    let oversized_body = vec![b'x'; 20 * 1024 * 1024 + 1];
    let response = http_upload(&server, &session, workspace, oversized_body, boundary).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["code"], "asset_too_large");
    assert!(!server
        .root
        .path()
        .join("spaces/left/notes/huge.png")
        .exists());
    assert!(!server
        .root
        .path()
        .join("spaces/left/notes/reader.png")
        .exists());
}

#[tokio::test]
async fn http_multipart_upload_names_images_and_revalidates_etags() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let boundary = "librarian-image-boundary";
    let png = include_bytes!("../../../server/testdata/images/tiny.png");
    let upload = |operation_id: &str| {
        let body = multipart_image_body(boundary, operation_id, "photo.png", png);
        server
            .client
            .post(format!(
                "{}/api/v1/workspaces/{workspace}/assets",
                server.url
            ))
            .header(header::COOKIE, &session.cookie)
            .header(header::ORIGIN, &server.url)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
    };
    let first = upload("22222222-2222-4222-8222-222222222222")
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);
    let first: Value = first.json().await.unwrap();
    assert_eq!(first["path"], "notes/photo.png");
    assert_eq!(first["width"], 2);
    assert_eq!(first["height"], 3);
    let second = upload("33333333-3333-4333-8333-333333333333")
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CREATED);
    let second: Value = second.json().await.unwrap();
    assert_eq!(second["path"], "notes/photo-2.png");
    let upper = multipart_upload_body(
        boundary,
        &[
            ("operationId", "34343434-3434-4434-8434-343434343434"),
            ("targetDirectory", "notes"),
            ("fileName", "PHOTO.PNG"),
        ],
        "PHOTO.PNG",
        "image/png",
        png,
    );
    let upper = http_upload(&server, &session, workspace, upper, boundary).await;
    assert_eq!(upper.status(), StatusCode::CREATED);
    let upper: Value = upper.json().await.unwrap();
    assert_eq!(upper["path"], "notes/PHOTO-3.PNG");

    let reject = |operation: &str| {
        let body = multipart_upload_body(
            boundary,
            &[
                ("operationId", operation),
                ("targetDirectory", "notes"),
                ("fileName", "strict.png"),
                ("conflictPolicy", "reject"),
            ],
            "strict.png",
            "image/png",
            png,
        );
        http_upload(&server, &session, workspace, body, boundary)
    };
    let created = reject("dddddddd-1111-4111-8111-111111111111").await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: Value = created.json().await.unwrap();
    let retried = reject("dddddddd-1111-4111-8111-111111111111").await;
    assert_eq!(retried.status(), StatusCode::CREATED);
    let retried: Value = retried.json().await.unwrap();
    assert_eq!(retried["path"], created["path"]);
    assert_eq!(retried["commitId"], created["commitId"]);
    let conflict = reject("eeeeeeee-2222-4222-8222-222222222222").await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let conflict: Value = conflict.json().await.unwrap();
    assert_eq!(conflict["code"], "asset_path_exists");

    let asset_url = format!(
        "{}/api/v1{}",
        server.url,
        first["assetPath"].as_str().unwrap()
    );
    let response = server
        .client
        .get(&asset_url)
        .header(header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );
    let etag = response.headers()[header::ETAG].clone();
    let revalidated = server
        .client
        .get(&asset_url)
        .header(header::COOKIE, &session.cookie)
        .header(header::IF_NONE_MATCH, etag)
        .send()
        .await
        .unwrap();
    assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn static_reading_pages_serve_private_documents_and_share_snapshots() {
    let server = Server::boot().await;
    let session = server.connect("alice", "left").await;
    let workspaces = server.product_get(&session, "/workspaces").await;
    let workspace = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["spaceId"] == "left")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let origin = server.url.clone();
    let created = server
        .client
        .post(format!(
            "{}/api/v1/workspaces/{workspace}/documents",
            server.url
        ))
        .header(header::COOKIE, &session.cookie)
        .header(header::ORIGIN, &origin)
        .json(&json!({
            "path": "static/Page.md",
            "markdown": "# 静态阅读\n\n[下一篇](Other.md) <script>alert(1)</script>\n",
            "baseRevision": null,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: Value = created.json().await.unwrap();
    let document = created["document"]["id"].as_str().unwrap();
    let other = server
        .client
        .post(format!(
            "{}/api/v1/workspaces/{workspace}/documents",
            server.url
        ))
        .header(header::COOKIE, &session.cookie)
        .header(header::ORIGIN, &origin)
        .json(&json!({
            "path": "static/Other.md",
            "markdown": "# 下一篇\n\n正文。\n",
            "baseRevision": null,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), StatusCode::CREATED);
    let other: Value = other.json().await.unwrap();
    let other = other["document"]["id"].as_str().unwrap();

    let css = server
        .client
        .get(format!("{}/assets/static-reading.css", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(css.status(), StatusCode::OK);
    assert_eq!(css.headers()[header::CONTENT_TYPE], "text/css");
    assert_eq!(css.headers()[header::CACHE_CONTROL], "no-cache");
    assert!(css.text().await.unwrap().contains(".reading"));

    let private_url = format!(
        "{}/workspaces/{workspace}/documents/{document}/read",
        server.url
    );
    let private = server
        .client
        .get(&private_url)
        .header(header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(private.status(), StatusCode::OK);
    assert_eq!(
        private.headers()[header::CONTENT_SECURITY_POLICY],
        "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    assert_eq!(private.headers()[header::CACHE_CONTROL], "no-store");
    let html = private.text().await.unwrap();
    assert!(html.contains("<h1 id=\"静态阅读\">"), "{html}");
    assert!(
        html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
        "{html}"
    );
    assert!(!html.contains("<script>alert(1)</script>"), "{html}");
    assert!(
        html.contains(&format!(
            "href=\"/workspaces/{workspace}/documents/{other}/read\""
        )),
        "{html}"
    );
    assert!(!html.contains("<div id=\"root\"></div>"), "{html}");

    let anonymous_private = server.client.get(&private_url).send().await.unwrap();
    assert_eq!(anonymous_private.status(), StatusCode::SEE_OTHER);
    assert!(anonymous_private.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .starts_with("/.auth/librarian/login?next="));

    let snapshot = server
        .client
        .post(format!(
            "{}/api/v1/workspaces/{workspace}/snapshots",
            server.url
        ))
        .header(header::COOKIE, &session.cookie)
        .header(header::ORIGIN, &origin)
        .json(&json!({
            "kind": "current",
            "audience": "share",
            "documentIds": [document, other],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::CREATED);
    let snapshot: Value = snapshot.json().await.unwrap();
    let snapshot_id = snapshot["id"].as_str().unwrap();
    let share_url = format!("{}/r/{snapshot_id}/read", server.url);
    let share = server.client.get(&share_url).send().await.unwrap();
    assert_eq!(share.status(), StatusCode::OK);
    let html = share.text().await.unwrap();
    assert!(html.contains("静态阅读"), "{html}");
    assert!(html.contains("阅读地址中的文档"), "{html}");
    assert!(
        html.contains(&format!(
            "href=\"/r/{snapshot_id}/read?documentId={other}\""
        )),
        "{html}"
    );
    assert!(!html.contains("<script>alert(1)</script>"), "{html}");

    let revoked = server
        .client
        .delete(format!("{}/api/v1/snapshots/{snapshot_id}", server.url))
        .header(header::COOKIE, &session.cookie)
        .header(header::ORIGIN, &origin)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let after = server.client.get(&share_url).send().await.unwrap();
    assert_eq!(after.status(), StatusCode::NOT_FOUND);
}
