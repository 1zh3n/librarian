use std::{fs, path::PathBuf};

use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server_common::revision::sha256_hex;
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGINAL: &str = "\u{feff}初稿\r\n😀\n";
const RUNNER: &str = "synthetic-conversation-runner";

struct Fixture {
    root: TempDir,
    app: Router,
    user: String,
    peer: String,
    ws: String,
    doc: String,
    foreign_doc: String,
}

impl Fixture {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        let token = |name| {
            users
                .create_user(name, "synthetic-password", false, Profile::default())
                .unwrap();
            users.create_token(name, "test").unwrap()
        };
        let user = token("author");
        let peer = token("peer");
        for name in ["one", "two"] {
            let dir = root.path().join("spaces").join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("note.md"), ORIGINAL).unwrap();
        }
        let mut config = json!({});
        for name in ["one", "two"] {
            config[name] = json!({"name": name,"binding":{"prefix":format!("/{name}")},"access":"none","revisions":"managed","revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300},"members":{"author":{"role":"write"},"peer":{"role":"read"}}});
        }
        fs::write(root.path().join("spaces.json"), config.to_string()).unwrap();
        fs::create_dir(root.path().join(".librarian")).unwrap();
        fs::write(
            root.path().join(".librarian/runner-token.sha256"),
            sha256_hex(RUNNER.as_bytes()),
        )
        .unwrap();
        let product = librarian::Product::open(root.path(), 0).unwrap();
        product
            .manager()
            .instance("one")
            .unwrap()
            .revisions
            .as_ref()
            .unwrap()
            .snapshot_now()
            .unwrap();
        let app = product.router();
        let mut f = Self {
            root,
            app,
            user,
            peer,
            ws: String::new(),
            doc: String::new(),
            foreign_doc: String::new(),
        };
        let spaces = f.get("/workspaces").await;
        for space in spaces.as_array().unwrap() {
            let ws = field(space, "id");
            let docs = f.get(&format!("/workspaces/{ws}/documents")).await;
            if space["name"] == "one" {
                f.ws = ws;
                f.doc = field(&docs[0], "id");
            } else {
                f.foreign_doc = field(&docs[0], "id");
            }
        }
        f
    }
    async fn req(&self, token: &str, method: &str, path: &str, input: Value) -> (u16, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .header("last-event-id", "1")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 5_000_000).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
        )
    }
    async fn ok(&self, token: &str, method: &str, path: &str, input: Value) -> Value {
        let (s, v) = self.req(token, method, path, input).await;
        assert!((200..300).contains(&s), "{method} {path}: {s} {v}");
        v
    }
    async fn get(&self, path: &str) -> Value {
        self.ok(&self.user, "GET", path, Value::Null).await
    }
    async fn conversation(&self, token: &str, doc: Option<&str>) -> String {
        let (status, v) = self
            .req(
                token,
                "POST",
                "/ai/conversations",
                json!({"workspaceId":self.ws,"documentId":doc}),
            )
            .await;
        assert_eq!(status, 201, "{v}");
        field(&v, "id")
    }
    async fn send(&self, c: &str, key: &str, mode: &str, prompt: &str) -> Value {
        self.ok(
            &self.user,
            "POST",
            &turns(c),
            json!({"clientTurnId":key,"mode":mode,"prompt":prompt}),
        )
        .await
    }
    async fn claim(&self) -> Value {
        self.ok(RUNNER, "POST", "/ai/runner/claims", json!({}))
            .await
    }
    async fn submit(&self, lease: &str, result: Value) -> (u16, Value) {
        self.req(
            RUNNER,
            "PUT",
            &format!("/ai/runner/claims/{lease}/result"),
            result,
        )
        .await
    }
    async fn cancel(&self, c: &str, t: &Value) -> Value {
        self.ok(
            &self.user,
            "POST",
            &format!("{}/{}/cancel", turns(c), field(t, "id")),
            json!({}),
        )
        .await
    }
    async fn edit(&self, lease: &str, replacement: Value) -> Value {
        let read = self
            .ok(
                RUNNER,
                "POST",
                &format!("/ai/runner/claims/{lease}/sources"),
                json!({"documentId":self.doc}),
            )
            .await;
        json!({"answer":"answer-private","edits":[{"path":"note.md","baseRevision":read["source"]["revision"],"markdown":replacement}]})
    }
    fn note(&self) -> PathBuf {
        self.root.path().join("spaces/one/note.md")
    }
    fn db(&self) -> Connection {
        Connection::open(self.root.path().join(".librarian/metadata.sqlite3")).unwrap()
    }
    fn reopen(&mut self) {
        self.app = Router::new();
        self.app = librarian::Product::open(self.root.path(), 0)
            .unwrap()
            .router();
    }
}
fn field(v: &Value, k: &str) -> String {
    v[k].as_str()
        .unwrap_or_else(|| panic!("missing {k} in {v}"))
        .to_owned()
}
fn base(c: &str) -> String {
    format!("/ai/conversations/{c}")
}
fn turns(c: &str) -> String {
    format!("{}/turns", base(c))
}

#[tokio::test]
async fn lists_workspace_and_document_conversations_without_scope_leak() {
    let mut f = Fixture::open().await;
    let a = f.conversation(&f.user, None).await;
    let b = f.conversation(&f.user, None).await;
    let d = f.conversation(&f.user, Some(&f.doc)).await;
    f.conversation(&f.peer, None).await;
    let list = format!("/ai/conversations?workspaceId={}", f.ws);
    assert_eq!(
        f.get(&format!("{list}&documentId={}", f.doc)).await["items"][0]["id"],
        d
    );
    let page = f.get(&format!("{list}&limit=1")).await;
    let cursor = field(&page, "nextCursor");
    f.reopen();
    let next = f.get(&format!("{list}&limit=1&cursor={cursor}")).await;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    let mut ids = vec![
        field(&page["items"][0], "id"),
        field(&next["items"][0], "id"),
    ];
    ids.sort();
    let mut wanted = vec![a.clone(), b];
    wanted.sort();
    assert_eq!(ids, wanted);
    assert!(next["nextCursor"].is_null());
    for (method, path) in [("GET", base(&a)), ("GET", turns(&a)), ("DELETE", base(&a))] {
        assert_eq!(f.req(&f.peer, method, &path, Value::Null).await.0, 404);
    }
}

#[tokio::test]
async fn turn_cannot_override_conversation_scope() {
    let f = Fixture::open().await;
    let c = f.conversation(&f.user, Some(&f.doc)).await;
    let mut body = json!({"clientTurnId":"same","mode":"chat","prompt":"read"});
    for (key, value) in [
        ("workspaceId", json!(f.ws)),
        ("documentId", json!(f.foreign_doc)),
    ] {
        body[key] = value;
        assert_eq!(
            f.req(&f.user, "POST", &turns(&c), body.clone()).await.0,
            422
        );
        body.as_object_mut().unwrap().remove(key);
    }
    for (ctx, status) in [
        (json!({"documentId":f.foreign_doc}), 404),
        (json!({"documentId":f.doc,"revision":"outdated"}), 409),
        (json!({"documentId":f.doc,"from":0,"to":1}), 422),
        (
            json!({"documentId":f.doc,"revision":sha256_hex(ORIGINAL.as_bytes()),"from":5,"to":6}),
            422,
        ),
    ] {
        body["context"] = json!([ctx]);
        assert_eq!(
            f.req(&f.user, "POST", &turns(&c), body.clone()).await.0,
            status
        );
    }
    let other = f.conversation(&f.peer, None).await;
    assert_eq!(
        f.req(
            &f.peer,
            "POST",
            &turns(&other),
            json!({"clientTurnId":"k","mode":"edit","prompt":"write"})
        )
        .await
        .0,
        403
    );
    let turn = f.send(&c, "same", "chat", "read").await;
    let claim = f.claim().await;
    assert_eq!(claim["operationId"], turn["operationId"]);
    assert_eq!(claim["input"]["documentId"], f.doc);
}

#[tokio::test]
async fn sends_one_operation_for_same_client_turn_id() {
    let f = Fixture::open().await;
    let c = f.conversation(&f.user, None).await;
    let path = turns(&c);
    let input = json!({"clientTurnId":"k","mode":"chat","prompt":"read"});
    f.db().execute_batch("CREATE TRIGGER reject_turn BEFORE INSERT ON ai_turns BEGIN SELECT RAISE(ABORT,'test rollback'); END;").unwrap();
    assert_eq!(f.req(&f.user, "POST", &path, input.clone()).await.0, 500);
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM ai_operations", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    f.db().execute_batch("DROP TRIGGER reject_turn").unwrap();
    let send = || f.req(&f.user, "POST", &path, input.clone());
    let (a, b) = tokio::join!(send(), send());
    assert_eq!(a.0, 202);
    assert_eq!(a, b);
    assert_eq!(
        f.req(
            &f.user,
            "POST",
            &path,
            json!({"clientTurnId":"k","mode":"chat","prompt":"changed"})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        f.req(
            &f.user,
            "POST",
            &path,
            json!({"clientTurnId":"other","mode":"chat","prompt":"read"})
        )
        .await
        .0,
        409
    );
    let lease = field(&f.claim().await, "leaseId");
    f.cancel(&c, &a.1).await;
    let retry =
        json!({"clientTurnId":"retry","mode":"chat","prompt":"read","retryOfTurnId":a.1["id"]});
    let other = f.conversation(&f.user, None).await;
    assert_eq!(
        f.req(&f.user, "POST", &turns(&other), retry.clone())
            .await
            .0,
        404
    );
    let second = f.ok(&f.user, "POST", &path, retry).await;
    assert_eq!(second["retryOfTurnId"], a.1["id"]);
    assert_ne!(second["operationId"], a.1["operationId"]);
    assert!(f.submit(&lease, json!({"answer":"late"})).await.0 >= 400);
    assert!(
        f.req(
            RUNNER,
            "POST",
            &format!("/ai/runner/claims/{lease}/events"),
            json!({"executorSeq":1,"kind":"text_delta","text":"late"})
        )
        .await
        .0 >= 400
    );
}

#[tokio::test]
async fn persists_bounded_history_with_account_and_workspace_scope() {
    let mut f = Fixture::open().await;
    let c = f.conversation(&f.user, None).await;
    let other = f.conversation(&f.user, None).await;
    f.send(&other, "p", "chat", "other-conversation").await;
    let lease = field(&f.claim().await, "leaseId");
    assert_eq!(
        f.submit(&lease, json!({"answer":"foreign answer"})).await.0,
        200
    );
    for i in 0usize..14 {
        if i == 13 {
            f.reopen();
        }
        f.send(&c, &format!("key{i}"), "chat", &format!("问{i}"))
            .await;
        let claim = f.claim().await;
        let want: Vec<_> = (i.saturating_sub(12)..i)
            .map(|j| json!({"prompt":format!("问{j}"),"answer":format!("答{j}")}))
            .collect();
        assert_eq!(claim["input"]["history"], json!(want));
        assert_eq!(claim["input"]["historyTruncated"], i > 12);
        assert_eq!(
            f.submit(
                &field(&claim, "leaseId"),
                json!({"answer":format!("答{i}")})
            )
            .await
            .0,
            200
        );
    }
    let page = f.get(&format!("{}?limit=1", turns(&c))).await;
    assert_eq!(page["items"][0]["prompt"], "问0");
    assert_eq!(page["items"][0]["operation"]["answer"], "答0");
    let next = f
        .get(&format!(
            "{}?limit=1&cursor={}",
            turns(&c),
            field(&page, "nextCursor")
        ))
        .await;
    assert_eq!(next["items"][0]["prompt"], "问1");
    // Simulate an administrator withdrawing workspace membership while the service is offline.
    f.app = Router::new();
    let path = f.root.path().join("spaces.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["one"]["members"]
        .as_object_mut()
        .unwrap()
        .remove("author");
    fs::write(path, config.to_string()).unwrap();
    f.reopen();
    assert_eq!(f.req(&f.user, "GET", &turns(&c), Value::Null).await.0, 404);
}

#[tokio::test]
async fn cancel_and_commit_race_has_one_terminal_outcome() {
    let f = Fixture::open().await;
    let c = f.conversation(&f.user, None).await;
    let stopped = f.send(&c, "stop-first", "edit", "edit").await;
    let lease = field(&f.claim().await, "leaseId");
    let change = f.edit(&lease, json!("updated")).await;
    assert_eq!(
        f.cancel(&c, &stopped).await["operation"]["status"],
        "canceled"
    );
    assert!(f.submit(&lease, change).await.0 >= 400);
    assert_eq!(fs::read_to_string(f.note()).unwrap(), ORIGINAL);
    let confirm = f.send(&c, "pending", "edit", "delete").await;
    let lease = field(&f.claim().await, "leaseId");
    let pending = f.submit(&lease, f.edit(&lease, Value::Null).await).await.1;
    assert_eq!(pending["status"], "needs_confirmation");
    f.cancel(&c, &confirm).await;
    assert_eq!(
        f.req(
            &f.user,
            "POST",
            &format!("/ai/operations/{}/confirm", field(&confirm, "operationId")),
            json!({"confirmationId":pending["confirmation"]["id"]})
        )
        .await
        .0,
        409
    );
    assert_eq!(fs::read_to_string(f.note()).unwrap(), ORIGINAL);
    let done = f.send(&c, "result-first", "edit", "edit").await;
    let lease = field(&f.claim().await, "leaseId");
    let reply = f
        .submit(&lease, f.edit(&lease, json!("updated")).await)
        .await
        .1;
    assert_eq!(reply["status"], "succeeded");
    assert_eq!(f.cancel(&c, &done).await["operation"], reply);
    assert_eq!(fs::read_to_string(f.note()).unwrap(), "updated");
}

#[tokio::test]
async fn deleted_conversation_cannot_replay_content_but_revision_can_be_undone() {
    let mut f = Fixture::open().await;
    let c = f.conversation(&f.user, None).await;
    let other = f.conversation(&f.user, None).await;
    let edited = f.send(&c, "edit", "edit", "prompt-private").await;
    let lease = field(&f.claim().await, "leaseId");
    let event = format!("/ai/runner/claims/{lease}/events");
    f.ok(
        RUNNER,
        "POST",
        &event,
        json!({"kind":"text_delta","executorSeq":1,"text":"stream-private"}),
    )
    .await;
    let committed = f
        .submit(&lease, f.edit(&lease, json!("updated")).await)
        .await
        .1;
    let op = format!("/ai/operations/{}", field(&edited, "operationId"));
    let stream = f.get(&format!("{op}/events")).await;
    assert!(stream.as_str().unwrap().contains("stream-private"));
    let queued = f.send(&c, "next", "chat", "excerpt-private").await;
    f.ok(&f.user, "DELETE", &base(&c), Value::Null).await;
    f.reopen();
    assert_eq!(f.req(&f.user, "GET", &base(&c), Value::Null).await.0, 404);
    assert_eq!(
        f.req(
            &f.user,
            "GET",
            &format!("/ai/operations/{}", field(&queued, "operationId")),
            Value::Null
        )
        .await
        .0,
        404
    );
    f.get(&base(&other)).await;
    assert!(
        f.req(
            RUNNER,
            "POST",
            &event,
            json!({"kind":"text_delta","executorSeq":2,"text":"stream-private"})
        )
        .await
        .0 >= 400
    );
    let receipt = f.get(&op).await;
    assert_eq!(receipt["commitId"], committed["commitId"]);
    assert!(receipt["answer"].is_null());
    let recent = f.get(&format!("/ai/operations?workspaceId={}", f.ws)).await;
    let replay = f.get(&format!("{op}/events")).await;
    let db = f.db();
    let mut stored = String::new();
    for (table, col) in [
        ("ai_operations", "entry"),
        ("ai_events", "payload"),
        ("ai_turns", "prompt"),
    ] {
        stored.push_str(
            &db.query_row(
                &format!("SELECT coalesce(group_concat({col}), '') FROM {table}"),
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        );
    }
    for marker in [
        "prompt-private",
        "answer-private",
        "stream-private",
        "excerpt-private",
    ] {
        assert!(
            !format!("{receipt} {recent} {replay} {stored}").contains(marker),
            "{marker}"
        );
    }
    assert!(f.get(&format!("{op}/diff?path=note.md")).await["diff"]
        .as_str()
        .unwrap()
        .contains("updated"));
    f.ok(&f.user, "POST", &format!("{op}/undo"), json!({}))
        .await;
    assert_eq!(fs::read(f.note()).unwrap(), ORIGINAL.as_bytes());
}
