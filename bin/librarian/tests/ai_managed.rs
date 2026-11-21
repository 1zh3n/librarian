//! Managed runner authorization at the HTTP boundary. The fixture installs
//! synthetic credentials in a fresh data root. No provider calls are made.
use std::fs;

use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Request},
    Router,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server_common::{crypto::encrypt_bound, revision::sha256_hex};
use tempfile::TempDir;
use tower::ServiceExt;

#[path = "fixtures/ai-materials/setup.rs"]
mod config;
#[path = "ai_managed/global_edits.rs"]
mod global_edits;

const V1: &str = "/ai/runner";
const V2: &str = "/ai/runner/v2";
const OLD: &str = "legacy-test-only";
const OTHER: &str = "another-instance-test-only";
const ORIGINAL: &str = "\u{feff}合成原文  \r\n";

#[derive(Clone, Copy)]
struct Auth<'a> {
    token: &'a str,
    instance: Option<&'a str>,
}

const OWNER: Auth = Auth {
    token: config::RUNNER,
    instance: Some(config::INSTANCE),
};
const FOREIGN: Auth = Auth {
    token: OTHER,
    instance: Some("another"),
};
const LEGACY: Auth = Auth {
    token: OLD,
    instance: None,
};

struct Reply {
    status: u16,
    headers: HeaderMap,
    json: Value,
}

async fn call(app: &Router, auth: Auth<'_>, method: &str, path: &str, body: Value) -> Reply {
    let mut req = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"))
        .header("authorization", format!("Bearer {}", auth.token))
        .header("content-type", "application/json");
    if let Some(id) = auth.instance {
        req = req.header("x-librarian-runner-id", id);
    }
    let (parts, data) = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
        .into_parts();
    let bytes = to_bytes(data, 1_000_000).await.unwrap();
    Reply {
        status: parts.status.as_u16(),
        headers: parts.headers,
        json: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

struct Site {
    root: TempDir,
    app: Router,
    member: String,
    workspace: String,
    doc: String,
}

impl Site {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        users
            .create_user("writer", "fixture-password", false, Profile::default())
            .unwrap();
        users
            .create_user("admin", "fixture-password", true, Profile::default())
            .unwrap();
        let member = users.create_token("writer", "fixture").unwrap();
        let folder = root.path().join("spaces/field");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("one.md"), ORIGINAL).unwrap();
        fs::write(
            root.path().join("spaces.json"),
            json!({"field":{
            "name":"Field", "binding":{"prefix":"/field"}, "access":"none", "revisions":"managed",
            "members":{"writer":{"role":"write"}}}})
            .to_string(),
        )
        .unwrap();
        let private = root.path().join(".librarian");
        fs::create_dir_all(&private).unwrap();
        fs::write(
            private.join("runner-token.sha256"),
            sha256_hex(OLD.as_bytes()),
        )
        .unwrap();
        fs::write(private.join("ai-test-loopback"), "127.0.0.1:9").unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap().router();
        config::configure(root.path()).unwrap();
        // The materials fixture never obtains a provider credential. This suite does.
        Connection::open(private.join("metadata.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE ai_connections SET base_url='https://127.0.0.1:9' WHERE id='local'",
                [],
            )
            .unwrap();
        let auth = Auth {
            token: &member,
            instance: None,
        };
        let spaces = call(&app, auth, "GET", "/workspaces", Value::Null).await;
        let workspace = spaces.json[0]["id"].as_str().unwrap().to_owned();
        let docs = call(
            &app,
            auth,
            "GET",
            &format!("/workspaces/{workspace}/documents"),
            Value::Null,
        )
        .await;
        let doc = docs.json[0]["id"].as_str().unwrap().to_owned();
        let site = Self {
            root,
            app,
            member,
            workspace,
            doc,
        };
        site.db().execute("INSERT INTO ai_runner_instances(id,token_digest,last_seen) VALUES ('another',?,unixepoch())",
            [sha256_hex(OTHER.as_bytes())]).unwrap();
        site
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

    async fn enqueue(&self) -> Reply {
        call(&self.app,Auth {token:&self.member,instance:None},"POST","/ai/operations",
            json!({"workspaceId":self.workspace,"documentId":self.doc,"mode":"edit","prompt":"修改合成正文"})).await
    }
    async fn claim(&self, protocol: &str, who: Auth<'_>) -> Reply {
        call(
            &self.app,
            who,
            "POST",
            &format!("{protocol}/claims"),
            json!({}),
        )
        .await
    }
    async fn managed_lease(&self) -> String {
        let enqueued = self.enqueue().await;
        assert_eq!(enqueued.status, 202, "{}", enqueued.json);
        let claim = self.claim(V2, OWNER).await;
        assert_eq!(claim.status, 200, "{}", claim.json);
        assert_eq!(claim.json["operationId"], enqueued.json["id"]);
        assert_eq!(claim.json["taskKind"], "chat");
        assert_eq!(claim.json["selection"]["modelId"], "material-test");
        assert_eq!(claim.json["selection"]["maxOutputTokens"], 1024);
        assert!(!claim.json.to_string().contains("fixture-only"));
        claim.json["leaseId"].as_str().unwrap().to_owned()
    }
    async fn denied_routes(&self, protocol: &str, auth: Auth<'_>, lease: &str) {
        let result = json!({"answer":"不应写入","sourceIds":[],"edits":[]});
        for (method, route, input) in [
            ("GET", "documents", Value::Null),
            ("POST", "sources", json!({"documentId":self.doc})),
            (
                "POST",
                "events",
                json!({"kind":"text_delta","executorSeq":1,"text":"unauthorized fragment"}),
            ),
            ("POST", "renew", json!({})),
            ("GET", "provider", Value::Null),
            ("PUT", "result", result),
            ("POST", "fail", json!({"text":"unauthorized failure"})),
        ] {
            let path = format!("{protocol}/claims/{lease}/{route}");
            let reply = call(&self.app, auth, method, &path, input).await;
            assert!(
                matches!(reply.status, 401 | 403 | 404 | 409 | 410),
                "{method} {path}: {}",
                reply.status
            );
            assert!(!reply.json.to_string().contains("fixture-only"));
        }
    }

    fn original(&self) {
        assert_eq!(
            fs::read(self.root.path().join("spaces/field/one.md")).unwrap(),
            ORIGINAL.as_bytes()
        );
    }
}

#[tokio::test]
async fn managed_runner_cannot_read_another_runners_lease() {
    let site = Site::new().await;
    let lease = site.managed_lease().await;
    for auth in [
        FOREIGN,
        Auth {
            instance: OWNER.instance,
            token: OTHER,
        },
        LEGACY,
    ] {
        site.denied_routes(V2, auth, &lease).await;
    }
    for route in ["heartbeat", "claims"] {
        for auth in [
            LEGACY,
            Auth {
                instance: OWNER.instance,
                token: OTHER,
            },
            Auth {
                instance: None,
                token: config::RUNNER,
            },
        ] {
            let r = call(&site.app, auth, "POST", &format!("{V2}/{route}"), json!({})).await;
            assert!(
                matches!(r.status, 401 | 403),
                "{route} returned {}",
                r.status
            );
        }
    }
    let base = format!("{V2}/claims/{lease}");
    let provider = call(
        &site.app,
        OWNER,
        "GET",
        &format!("{base}/provider"),
        Value::Null,
    )
    .await;
    assert_eq!(provider.status, 200, "{}", provider.json);
    assert_eq!(provider.headers["cache-control"], "no-store");
    assert_eq!(provider.json["apiKey"], "fixture-only");
    assert_eq!(provider.json["pinnedIp"], "127.0.0.1");
    assert!(provider.json["messagesUrl"]
        .as_str()
        .unwrap()
        .ends_with("/v1/messages"));
    let repeated = call(
        &site.app,
        OWNER,
        "GET",
        &format!("{base}/provider"),
        Value::Null,
    )
    .await;
    assert!(matches!(repeated.status, 403 | 404 | 409 | 410));
    assert!(!repeated.json.to_string().contains("fixture-only"));
    let receipt = call(
        &site.app,
        OWNER,
        "PUT",
        &format!("{base}/result"),
        json!({"answer":"visible","edits":[]}),
    )
    .await;
    assert_eq!(receipt.status, 200);
    assert_eq!(receipt.json["answer"], "visible");
    site.original();
}

#[tokio::test]
async fn legacy_and_managed_protocols_remain_disjoint_across_restart() {
    let mut site = Site::new().await;
    site.db()
        .execute("UPDATE ai_configuration SET mode='legacy'", [])
        .unwrap();
    assert_eq!(site.enqueue().await.status, 202);
    assert_eq!(site.claim(V2, OWNER).await.status, 204);
    let old = site.claim(V1, LEGACY).await;
    assert_eq!(old.status, 200);
    let old_lease = old.json["leaseId"].as_str().unwrap();
    site.db()
        .execute("UPDATE ai_configuration SET mode='managed'", [])
        .unwrap();
    site.reopen();
    site.denied_routes(V2, OWNER, old_lease).await;
    let new = site.enqueue().await;
    assert_eq!(new.status, 202);
    assert_eq!(site.claim(V1, LEGACY).await.status, 204);
    let claim = site.claim(V2, OWNER).await;
    assert_eq!(claim.status, 200, "{}", claim.json);
    let lease = claim.json["leaseId"].as_str().unwrap();
    site.denied_routes(V1, LEGACY, lease).await;
    assert_eq!(
        call(
            &site.app,
            LEGACY,
            "PUT",
            &format!("{V1}/claims/{old_lease}/result"),
            json!({"answer":"旧任务一次完成"})
        )
        .await
        .status,
        200
    );
    site.original();
}

#[tokio::test]
async fn rotated_key_blocks_late_events_and_writes() {
    let site = Site::new().await;
    let lease = site.managed_lease().await;
    let base = format!("{V2}/claims/{lease}");
    let source = call(
        &site.app,
        OWNER,
        "POST",
        &format!("{base}/sources"),
        json!({"documentId":site.doc}),
    )
    .await;
    assert_eq!(source.status, 200, "{}", source.json);
    assert_eq!(source.json["markdown"], ORIGINAL);
    // Simulate a committed connection rotation between the read and the write.
    let rotated = encrypt_bound(&[18; 32], "different-test-only", b"local").unwrap();
    site.db()
        .execute(
            "UPDATE ai_connections SET version=version+1,ciphertext=? WHERE id='local'",
            [rotated],
        )
        .unwrap();
    let change = json!({"answer":"late","sourceIds":[source.json["source"]["id"]],"edits":[
        {"path":"one.md","baseRevision":source.json["source"]["revision"],"markdown":"迟到写入"}]});
    let write = call(&site.app, OWNER, "PUT", &format!("{base}/result"), change).await;
    assert!(
        matches!(write.status, 403 | 404 | 409 | 410),
        "{}",
        write.status
    );
    site.denied_routes(V2, OWNER, &lease).await;
    site.original();
}

#[tokio::test]
async fn expired_managed_lease_cannot_read_or_deliver() {
    let site = Site::new().await;
    let lease = site.managed_lease().await;
    let changed = site.db().execute("UPDATE ai_operations SET expires_at=1,entry=json_set(entry,'$.lease.expiresAt',1) WHERE lease_id=?",params![lease]).unwrap();
    assert_eq!(changed, 1);
    site.denied_routes(V2, OWNER, &lease).await;
    site.original();
}

#[tokio::test]
async fn offline_runner_blocks_new_work_and_unclaimed_tasks_expire() {
    let site = Site::new().await;
    site.db()
        .execute(
            "UPDATE ai_runner_instances SET last_seen=unixepoch()-31",
            [],
        )
        .unwrap();
    let offline = site.enqueue().await;
    assert_eq!(offline.status, 503, "{}", offline.json);
    assert_eq!(offline.json["code"], "runner_offline");
    let beat = call(
        &site.app,
        OWNER,
        "POST",
        &format!("{V2}/heartbeat"),
        json!({}),
    )
    .await;
    assert!(matches!(beat.status, 200 | 204));
    let queued = site.enqueue().await;
    assert_eq!(queued.status, 202);
    let id = queued.json["id"].as_str().unwrap();
    site.db().execute("UPDATE ai_operations SET entry=json_set(entry, '$.queuedAt', unixepoch()-121) WHERE id=?",[id]).unwrap();
    // No runner is available to poll. The member still observes the queue deadline.
    let result = call(
        &site.app,
        Auth {
            token: &site.member,
            instance: None,
        },
        "GET",
        &format!("/ai/operations/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(result.json["status"], "failed");
    assert_eq!(site.claim(V2, OWNER).await.status, 204);
    site.original();
}

#[tokio::test]
async fn revoking_the_workspace_role_blocks_all_lease_effects_after_restart() {
    let mut site = Site::new().await;
    let lease = site.managed_lease().await;
    let path = site.root.path().join("spaces.json");
    let mut spaces: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    spaces["field"]["members"] = json!({});
    fs::write(path, spaces.to_string()).unwrap();
    site.reopen();
    site.denied_routes(V2, OWNER, &lease).await;
    site.original();
}

#[tokio::test]
async fn pausing_ai_revokes_in_flight_effects_and_rejects_new_jobs() {
    let site = Site::new().await;
    let lease = site.managed_lease().await;
    site.db()
        .execute("UPDATE ai_configuration SET enabled=0", [])
        .unwrap();
    site.denied_routes(V2, OWNER, &lease).await;
    assert!(matches!(site.enqueue().await.status, 409 | 503));
    assert!(matches!(
        site.claim(V2, OWNER).await.status,
        204 | 409 | 503
    ));
    site.original();
}

#[tokio::test]
async fn probe_lease_is_instance_bound_and_cannot_access_workspace_tools() {
    let site = Site::new().await;
    let login = site
        .app
        .clone()
        .oneshot(
            Request::post("/.auth/librarian/login")
                .header("host", "localhost")
                .header("origin", "http://localhost")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from("username=admin&password=fixture-password"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status().as_u16(), 303);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let request = Request::post("/api/v1/ai/settings/connections/local/probe")
        .header("host", "localhost")
        .header("origin", "http://localhost")
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "modelId":"material-test","thinking":{"mode":"provider_default"}
            })
            .to_string(),
        ))
        .unwrap();
    let response = site.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 202);
    let probe: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(site.claim(V1, LEGACY).await.status, 204);
    let claim = site.claim(V2, OWNER).await;
    assert_eq!(claim.status, 200, "{}", claim.json);
    assert_eq!(claim.json["taskKind"], "probe");
    assert_eq!(claim.json["selection"]["maxOutputTokens"], 1024);
    assert_eq!(claim.json["operationId"], probe["id"]);
    assert!(claim.json.get("input").is_none());
    let lease = claim.json["leaseId"].as_str().unwrap();
    let path = format!("{V2}/claims/{lease}");
    site.denied_routes(V2, FOREIGN, lease).await;
    for (method, route, args) in [
        ("GET", "documents", Value::Null),
        ("POST", "sources", json!({"documentId":site.doc})),
        (
            "POST",
            "events",
            json!({"kind":"text_delta","executorSeq":1,"text":"private probe"}),
        ),
    ] {
        let reply = call(&site.app, OWNER, method, &format!("{path}/{route}"), args).await;
        assert!(
            matches!(reply.status, 403 | 404 | 409 | 422),
            "{route} {}",
            reply.status
        );
    }
    let provider = call(
        &site.app,
        OWNER,
        "GET",
        &format!("{path}/provider"),
        Value::Null,
    )
    .await;
    assert_eq!(provider.status, 200);
    assert_eq!(provider.headers["cache-control"], "no-store");
    let again = call(
        &site.app,
        OWNER,
        "GET",
        &format!("{path}/provider"),
        Value::Null,
    )
    .await;
    assert!(matches!(again.status, 403 | 404 | 409 | 410));
    let failure = json!({"code":"rate_limit","text":"untrusted synthetic error marker"});
    let receipt = call(
        &site.app,
        OWNER,
        "POST",
        &format!("{path}/fail"),
        failure.clone(),
    )
    .await;
    assert_eq!(receipt.status, 200);
    assert_eq!(receipt.json["errorCode"], "rate_limit");
    assert!(!receipt
        .json
        .to_string()
        .contains("untrusted synthetic error marker"));
    let replay = call(&site.app, OWNER, "POST", &format!("{path}/fail"), failure).await;
    assert_eq!(replay.status, 200);
    assert_eq!(replay.json, receipt.json);
    site.original();
}

#[tokio::test]
async fn managed_messages_url_uses_one_anthropic_segment() {
    for (base, messages) in [
        ("/anthropic", "/anthropic/v1/messages"),
        ("/tenant/anthropic/", "/tenant/anthropic/v1/messages"),
        ("/tenant/anthropic/v1", "/tenant/anthropic/v1/messages"),
        ("/tenant/v1", "/tenant/anthropic/v1/messages"),
        ("/tenant", "/tenant/anthropic/v1/messages"),
        ("/my-anthropic", "/my-anthropic/anthropic/v1/messages"),
        ("", "/anthropic/v1/messages"),
    ] {
        let site = Site::new().await;
        let origin = "https://127.0.0.1:9";
        site.db()
            .execute(
                "UPDATE ai_connections SET base_url=? WHERE id='local'",
                [format!("{origin}{base}")],
            )
            .unwrap();
        let lease = site.managed_lease().await;
        let provider = call(
            &site.app,
            OWNER,
            "GET",
            &format!("{V2}/claims/{lease}/provider"),
            Value::Null,
        )
        .await;
        assert_eq!(provider.status, 200);
        assert_eq!(
            provider.json["messagesUrl"],
            format!("{origin}{messages}"),
            "base {base}"
        );
    }
}

async fn check_interrupted_turn_after_rotation(delete: bool) {
    let mut site = Site::new().await;
    let member = Auth {
        token: &site.member,
        instance: None,
    };
    let conversation = call(
        &site.app,
        member,
        "POST",
        "/ai/conversations",
        json!({"workspaceId": site.workspace}),
    )
    .await;
    assert_eq!(conversation.status, 201);
    let path = format!(
        "/ai/conversations/{}",
        conversation.json["id"].as_str().unwrap()
    );
    let turn = call(
        &site.app,
        member,
        "POST",
        &format!("{path}/turns"),
        json!({"clientTurnId":"change","mode":"edit","prompt":"edit"}),
    )
    .await;
    assert_eq!(turn.status, 202);
    let claim = site.claim(V2, OWNER).await;
    assert_eq!(claim.status, 200);
    let lease = claim.json["leaseId"].as_str().unwrap();
    // Leave a verified, accepted result in the AI journal, immediately before its filesystem transaction.
    site.db()
        .execute_batch(
            "CREATE TRIGGER interrupt_mutation BEFORE INSERT ON mutations
        BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END;",
        )
        .unwrap();
    let result = call(&site.app, OWNER, "PUT", &format!("{V2}/claims/{lease}/result"), json!({
        "answer":"accepted", "edits":[{"path":"new.md","baseRevision":null,"markdown":"new content"}]
    })).await;
    assert_eq!(result.status, 500);
    let created = site.root.path().join("spaces/field/new.md");
    assert!(!created.exists());
    // Model the durable connection version after rotation, before the settings sweep.
    site.db()
        .execute_batch(
            "DROP TRIGGER interrupt_mutation;
        UPDATE ai_connections SET version=version+1 WHERE id='local';",
        )
        .unwrap();
    site.reopen();
    let member = Auth {
        token: &site.member,
        instance: None,
    };
    if delete {
        assert_eq!(
            call(&site.app, member, "DELETE", &path, Value::Null)
                .await
                .status,
            204
        );
    } else {
        let stop = format!("{path}/turns/{}/cancel", turn.json["id"].as_str().unwrap());
        let receipt = call(&site.app, member, "POST", &stop, json!({})).await;
        assert_eq!(receipt.status, 200);
        assert_eq!(receipt.json["operation"]["status"], "failed");
    }
    assert!(
        !created.exists(),
        "recovery committed an edit from a retired connection"
    );
}

#[tokio::test]
async fn cancel_reconciles_an_interrupted_turn_after_rotation() {
    check_interrupted_turn_after_rotation(false).await;
}

#[tokio::test]
async fn delete_reconciles_an_interrupted_turn_after_rotation() {
    check_interrupted_turn_after_rotation(true).await;
}

#[tokio::test]
async fn interrupted_source_receipt_preserves_the_read_budget() {
    let site = Site::new().await;
    let text = "a".repeat(150 * 1024);
    fs::write(site.root.path().join("spaces/field/one.md"), &text).unwrap();
    let lease = site.managed_lease().await;
    let path = format!("{V2}/claims/{lease}/sources");
    let request = json!({"documentId":site.doc});
    site.db().execute_batch("CREATE TRIGGER interrupt_source BEFORE UPDATE OF entry ON ai_operations
        WHEN json_array_length(NEW.entry, '$.delivered') > json_array_length(OLD.entry, '$.delivered')
        BEGIN SELECT RAISE(ABORT,'interrupted source receipt'); END;").unwrap();
    assert_eq!(
        call(&site.app, OWNER, "POST", &path, request.clone())
            .await
            .status,
        500
    );
    site.db()
        .execute_batch("DROP TRIGGER interrupt_source")
        .unwrap();
    let replay = call(&site.app, OWNER, "POST", &path, request).await;
    assert_eq!(replay.status, 200, "{}", replay.json["code"]);
    assert!(replay.json["markdown"] == text);
}
