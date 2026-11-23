use std::{fs, path::PathBuf, process::Command, time::SystemTime};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

const NOTE: &str = "\u{feff}江岸\r\n\n鹭鸟  \r";
const OUTLINE: &str = "## 提纲\r\n";
const PHOTO: &[u8] = b"\x89PNG\r\n\x1a\n\x00\xff";

struct Fixture {
    root: TempDir,
    app: Router,
    alice: String,
    bob: String,
    admin: String,
}

impl Fixture {
    fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        let token = |username, admin| {
            users
                .create_user(username, "only-a-test-password", admin, Profile::default())
                .unwrap();
            users.create_token(username, "workspaces-test").unwrap()
        };
        let alice = token("alice", false);
        let bob = token("bob", false);
        let admin = token("admin", true);
        let legacy = root.path().join("spaces/legacy");
        fs::create_dir_all(legacy.join("field/media")).unwrap();
        fs::write(legacy.join("Legacy.md"), "旧工作区。\n").unwrap();
        fs::write(legacy.join("field/Note.md"), NOTE).unwrap();
        fs::write(legacy.join("field/Note.outline.md"), OUTLINE).unwrap();
        fs::write(legacy.join("field/media/bird.png"), PHOTO).unwrap();
        fs::write(
            root.path().join("spaces.json"),
            json!({"legacy": {"name":"Legacy", "binding":{"prefix":"/legacy"},
                "revisions": "managed", "members":{"alice":{"role":"write"},"bob":{"role":"read"}}}})
                .to_string(),
        )
        .unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap().router();
        Self {
            root,
            app,
            alice,
            bob,
            admin,
        }
    }

    fn restart(&mut self) {
        self.app = Router::new();
        self.app = librarian::Product::open(self.root.path(), 0)
            .unwrap()
            .router();
    }

    async fn request(
        &self,
        user: &str,
        method: &str,
        path: &str,
        input: Value,
    ) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header("authorization", format!("Bearer {user}"))
                    .header("content-type", "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 262_144).await.unwrap();
        (
            parts.status,
            serde_json::from_slice(&bytes).unwrap_or_default(),
        )
    }

    async fn legacy(&self) -> Value {
        let (status, workspaces) = self
            .request(&self.alice, "GET", "/workspaces", Value::Null)
            .await;
        assert_eq!(status, StatusCode::OK, "{workspaces}");
        workspaces
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "Legacy")
            .unwrap()
            .clone()
    }

    async fn document(&self, user: &str, workspace: &str, path: &str) -> Value {
        let (status, documents) = self
            .request(
                user,
                "GET",
                &format!("/workspaces/{workspace}/documents"),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{documents}");
        documents
            .as_array()
            .unwrap()
            .iter()
            .find(|doc| doc["path"] == path)
            .unwrap()
            .clone()
    }

    fn folder(&self, workspace: &Value) -> PathBuf {
        self.root
            .path()
            .join("spaces")
            .join(workspace["spaceId"].as_str().unwrap())
    }
}

#[tokio::test]
async fn managed_workspaces_have_private_storage_and_creator_permissions_after_restart() {
    let mut f = Fixture::open();
    let (_, legacy_docs) = f
        .request(
            &f.bob,
            "GET",
            &format!(
                "/workspaces/{}/documents",
                f.legacy().await["id"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    assert!(legacy_docs
        .as_array()
        .unwrap()
        .iter()
        .any(|doc| doc["path"] == "Legacy.md"));

    let (status, created) = f
        .request(
            &f.alice,
            "POST",
            "/workspaces",
            json!({"name":"  田野手记  "}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["name"], "田野手记");
    assert_eq!(created["origin"], "native");
    assert_eq!(created["retention"], "persistent");
    assert_eq!(created["expiresAt"], Value::Null);
    assert_eq!(created["canManage"], true);
    assert_eq!(created["canWrite"], true);
    assert_eq!(created["revisionMode"], "managed");
    assert!(f.folder(&created).join(".git").exists());
    let (status, other) = f
        .request(&f.bob, "POST", "/workspaces", json!({"name":"田野手记"}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    assert_ne!(created["id"], other["id"]);
    assert_ne!(f.folder(&created), f.folder(&other));

    let target = format!("/workspaces/{}", created["id"].as_str().unwrap());
    assert_eq!(
        f.request(&f.bob, "PATCH", &target, json!({"name":"不可见"}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(&f.bob, "GET", &format!("{target}/documents"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(
            &f.alice,
            "PATCH",
            &format!("/workspaces/{}", f.legacy().await["id"].as_str().unwrap()),
            json!({"name":"成员不能管理旧空间"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    f.restart();
    let (status, renamed) = f
        .request(&f.alice, "PATCH", &target, json!({"name":"湿地名录"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["id"], created["id"]);
    assert_eq!(renamed["spaceId"], created["spaceId"]);
    assert_eq!(renamed["name"], "湿地名录");
    let (status, admin) = f
        .request(&f.admin, "PATCH", &target, json!({"name":"管理员更新"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{admin}");
    assert_eq!(admin["canManage"], true);
    assert_eq!(admin["name"], "管理员更新");
    let (_, visible) = f.request(&f.bob, "GET", "/workspaces", Value::Null).await;
    assert!(visible
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"] != created["id"]));
}

#[tokio::test]
async fn workspace_creation_rejects_storage_and_git_configuration() {
    let f = Fixture::open();
    for field in [
        "folder",
        "storagePath",
        "spaceId",
        "repository",
        "gitSync",
        "owner",
        "members",
    ] {
        let mut input = json!({"name":"配置不能由客户端提供"});
        input[field] = json!(".librarian");
        let (status, response) = f.request(&f.alice, "POST", "/workspaces", input).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field}: {response}"
        );
    }
    let (_, list) = f.request(&f.alice, "GET", "/workspaces", Value::Null).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn delivery_promotion_preserves_space_and_file_identity() {
    let mut f = Fixture::open();
    let expires = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let (status, temporary) = f.request(&f.alice, "POST", "/workspaces", json!({
        "name":"项目投递", "origin":"delivery", "retention":"temporary", "expiresAt":expires,
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{temporary}");
    assert_eq!(temporary["expiresAt"], expires);
    let path = format!("/workspaces/{}", temporary["id"].as_str().unwrap());
    let (status, document) = f
        .request(
            &f.alice,
            "POST",
            &format!("{path}/documents"),
            json!({
                "path":"Delivery.md", "markdown":NOTE, "baseRevision":null,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{document}");
    let (status, persistent) = f
        .request(&f.alice, "PATCH", &path, json!({"retention":"persistent"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{persistent}");
    assert_eq!(persistent["id"], temporary["id"]);
    assert_eq!(persistent["spaceId"], temporary["spaceId"]);
    assert_eq!(persistent["origin"], "delivery");
    assert_eq!(persistent["retention"], "persistent");
    assert_eq!(persistent["expiresAt"], Value::Null);

    f.restart();
    let (_, workspaces) = f.request(&f.alice, "GET", "/workspaces", Value::Null).await;
    assert!(workspaces.as_array().unwrap().contains(&persistent));
    let snapshot = format!(
        "/documents/{}",
        document["document"]["id"].as_str().unwrap()
    );
    let (_, current) = f.request(&f.alice, "GET", &snapshot, Value::Null).await;
    assert_eq!(current, document);
    assert_eq!(
        f.request(&f.bob, "GET", &snapshot, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fs::read(f.folder(&persistent).join("Delivery.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert!(f.folder(&persistent).join(".git").exists());
}

#[tokio::test]
async fn renaming_documents_and_directories_preserves_ids_and_exact_bytes() {
    let mut f = Fixture::open();
    let legacy = f.legacy().await;
    let workspace = legacy["id"].as_str().unwrap();
    let document = f.document(&f.alice, workspace, "field/Note.md").await;
    let id = document["id"].as_str().unwrap();
    let endpoint = format!("/workspaces/{workspace}/rename");
    let rename = json!({"operationId":"5f36b66a-5cc5-4cb4-8df1-9fdea3843158", "from":"field/Note.md", "to":"field/Notebook.md"});
    let (status, renamed) = f.request(&f.admin, "POST", &endpoint, rename.clone()).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    let (status, retry) = f.request(&f.admin, "POST", &endpoint, rename).await;
    assert_eq!(status, StatusCode::OK, "{retry}");
    assert_eq!(retry, renamed);
    assert_eq!(
        f.document(&f.alice, workspace, "field/Notebook.md").await["id"],
        id
    );

    let directory = json!({"operationId":"580c1e59-5247-4910-af20-22ca8f103ae9", "from":"field", "to":"wetlands"});
    let (status, moved) = f.request(&f.admin, "POST", &endpoint, directory).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_ne!(moved["commitId"], renamed["commitId"]);
    assert_eq!(moved["changes"].as_array().unwrap().len(), 6);
    let folder = f.folder(&legacy);
    assert!(!folder.join("field/Notebook.md").exists());
    assert_eq!(
        fs::read(folder.join("wetlands/Notebook.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert_eq!(
        fs::read(folder.join("wetlands/Notebook.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(
        fs::read(folder.join("wetlands/media/bird.png")).unwrap(),
        PHOTO
    );
    let obj = Command::new("git")
        .arg("-C")
        .arg(&folder)
        .args([
            "show",
            &format!(
                "{}:wetlands/media/bird.png",
                moved["commitId"].as_str().unwrap()
            ),
        ])
        .output()
        .unwrap();
    assert!(
        obj.status.success(),
        "{}",
        String::from_utf8_lossy(&obj.stderr)
    );
    assert_eq!(obj.stdout, PHOTO);

    f.restart();
    let (_, current) = f
        .request(&f.bob, "GET", &format!("/documents/{id}"), Value::Null)
        .await;
    assert_eq!(current["document"]["id"], id);
    assert_eq!(current["document"]["path"], "wetlands/Notebook.md");
    assert_eq!(current["markdown"], NOTE);
    let (_, outline) = f
        .request(
            &f.bob,
            "GET",
            &format!("/documents/{id}/outline"),
            Value::Null,
        )
        .await;
    assert_eq!(outline["markdown"], OUTLINE);
}

#[tokio::test]
async fn rename_conflicts_leave_original_files_and_ids_in_place() {
    let f = Fixture::open();
    let legacy = f.legacy().await;
    let workspace = legacy["id"].as_str().unwrap();
    let original = f.document(&f.alice, workspace, "field/Note.md").await;
    let endpoint = format!("/workspaces/{workspace}/rename");
    let (status, collision) = f.request(&f.admin, "POST", &endpoint, json!({
        "operationId":"7a2ab9dc-92a4-2f4c-b0c2-1fef291bdc27", "from":"field/Note.md", "to":"Legacy.md"
    })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{collision}");
    let (status, reserved) = f.request(&f.admin, "POST", &endpoint, json!({
        "operationId":"fbeb944e-507a-4a03-b6ad-c65e1b85bc37", "from":"field", "to":".librarian"
    })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{reserved}");
    let folder = f.folder(&legacy);
    assert_eq!(
        fs::read(folder.join("field/Note.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert_eq!(
        fs::read(folder.join("Legacy.md")).unwrap(),
        "旧工作区。\n".as_bytes()
    );
    assert_eq!(
        f.document(&f.alice, workspace, "field/Note.md").await,
        original
    );
}

#[tokio::test]
async fn startup_recovers_document_mapping_after_rename_commit_without_metadata_update() {
    let mut f = Fixture::open();
    let legacy = f.legacy().await;
    let workspace = legacy["id"].as_str().unwrap();
    let document = f.document(&f.alice, workspace, "field/Note.md").await;
    let id = document["id"].as_str().unwrap();
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER simulated_restart BEFORE UPDATE OF path ON documents
                      WHEN OLD.path != NEW.path BEGIN SELECT RAISE(FAIL, 'simulated restart'); END;").unwrap();
    let endpoint = format!("/workspaces/{workspace}/rename");
    let args = json!({"operationId":"f07ad9db-12dc-413c-9234-ed46be44d8aa", "from":"field/Note.md", "to":"Recovered.md"});
    let (status, failed) = f.request(&f.admin, "POST", &endpoint, args.clone()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failed}");
    assert_eq!(
        fs::read(f.folder(&legacy).join("Recovered.md")).unwrap(),
        NOTE.as_bytes()
    );
    let doc_path = format!("/documents/{id}");
    assert_eq!(
        f.request(&f.alice, "GET", &doc_path, Value::Null).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    db.execute_batch("DROP TRIGGER simulated_restart").unwrap();
    drop(db);

    f.restart();
    let (status, result) = f.request(&f.alice, "GET", &doc_path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["document"]["id"], id);
    assert_eq!(result["document"]["path"], "Recovered.md");
    assert_eq!(result["markdown"], NOTE);
    let (status, retried) = f.request(&f.admin, "POST", &endpoint, args).await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["changes"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn expiry_hides_and_sweeps_only_its_temporary_delivery_workspace() {
    let mut f = Fixture::open();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (status, temporary) = f.request(&f.alice, "POST", "/workspaces", json!({
        "name":"限时投递", "origin":"delivery", "retention":"temporary", "expiresAt": now+3600,
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{temporary}");
    let workspace = temporary["id"].as_str().unwrap();
    let (status, document) = f
        .request(
            &f.alice,
            "POST",
            &format!("/workspaces/{workspace}/documents"),
            json!({
                "path":"Ephemeral.md", "markdown":NOTE, "baseRevision":null,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{document}");
    let (status, token) = f
        .request(
            &f.alice,
            "POST",
            &format!("/workspaces/{workspace}/delivery-tokens"),
            json!({"name":"temporary build","deliveryId":"temporary-build"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{token}");
    let folder = f.folder(&temporary);
    assert!(folder.join("Ephemeral.md").exists());

    let db_file = f.root.path().join(".librarian/metadata.sqlite3");
    let db = rusqlite::Connection::open(&db_file).unwrap();
    db.execute(
        "UPDATE workspaces SET expires_at = ?1 WHERE id = ?2",
        rusqlite::params![now - 1, workspace],
    )
    .unwrap();
    let document_id = document["document"]["id"].as_str().unwrap();
    let (status, denied) = f
        .request(
            &f.alice,
            "GET",
            &format!("/documents/{document_id}"),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{denied}");
    let (_, visible) = f.request(&f.alice, "GET", "/workspaces", Value::Null).await;
    assert!(visible
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["id"] != workspace));
    drop(db);

    f.restart();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while folder.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Background retention cleanup removed the temporary delivery workspace");
    let db = rusqlite::Connection::open(&db_file).unwrap();
    let revoked: bool = db
        .query_row(
            "SELECT revoked FROM delivery_tokens WHERE workspace_id = ?1",
            [workspace],
            |row| row.get(0),
        )
        .unwrap();
    assert!(revoked);
    assert!(f.root.path().join("spaces/legacy/Legacy.md").exists());
}

#[tokio::test]
async fn startup_finishes_quarantined_workspace_cleanup_without_touching_reused_path() {
    let mut f = Fixture::open();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (status, temporary) = f.request(&f.alice, "POST", "/workspaces", json!({
        "name":"等待清理", "origin":"delivery", "retention":"temporary", "expiresAt":now+3600,
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{temporary}");
    let workspace = temporary["id"].as_str().unwrap();
    let source = f.folder(&temporary);
    f.app = Router::new();
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute(
        "UPDATE workspaces SET expires_at = ?1 WHERE id = ?2",
        rusqlite::params![now - 1, workspace],
    )
    .unwrap();
    drop(db);
    let quarantine_root = f.root.path().join(".librarian/retired-workspaces");
    fs::create_dir(&quarantine_root).unwrap();
    let quarantined = quarantine_root.join(temporary["spaceId"].as_str().unwrap());
    fs::rename(&source, &quarantined).unwrap();
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("Preserve.md"),
        "Different files added outside Librarian.\n",
    )
    .unwrap();

    f.restart();
    assert_eq!(
        fs::read(source.join("Preserve.md")).unwrap(),
        b"Different files added outside Librarian.\n"
    );
    assert!(!quarantined.exists());
    let configuration = fs::read_to_string(f.root.path().join("spaces.json")).unwrap();
    let configuration: Value = serde_json::from_str(&configuration).unwrap();
    assert!(configuration
        .get(temporary["spaceId"].as_str().unwrap())
        .is_none());
}

#[tokio::test]
async fn workspace_security_defaults_to_internal_and_exposes_capabilities() {
    let f = Fixture::open();
    let (status, created) = f
        .request(&f.alice, "POST", "/workspaces", json!({"name":"安全默认"}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["securityLevel"], "internal");
    assert_eq!(created["capabilities"]["externalAi"], true);
    assert_eq!(created["capabilities"]["externalMcp"], true);
    assert_eq!(created["capabilities"]["anonymousShare"], true);
    assert_eq!(created["capabilities"]["publication"], false);
    assert_eq!(created["capabilities"]["offline"], true);
    assert_eq!(created["capabilities"]["remoteBackup"], true);

    let (status, legacy) = f.request(&f.alice, "GET", "/workspaces", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let legacy = legacy
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "Legacy")
        .unwrap();
    assert_eq!(legacy["securityLevel"], "internal");
}

#[tokio::test]
async fn workspace_security_level_change_requires_management() {
    let f = Fixture::open();
    let (status, created) = f
        .request(&f.alice, "POST", "/workspaces", json!({"name":"等级管理"}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let path = format!("/workspaces/{id}");

    let (denied, _) = f
        .request(
            &f.bob,
            "PATCH",
            &path,
            json!({"securityLevel":"confidential"}),
        )
        .await;
    assert!(!denied.is_success(), "a non-member changed the level");

    let (status, updated) = f
        .request(
            &f.alice,
            "PATCH",
            &path,
            json!({"securityLevel":"confidential"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["securityLevel"], "confidential");
    assert_eq!(updated["capabilities"]["externalAi"], false);
    assert_eq!(updated["capabilities"]["externalMcp"], false);
    assert_eq!(updated["capabilities"]["anonymousShare"], false);
    assert_eq!(updated["capabilities"]["publication"], false);
    assert_eq!(updated["capabilities"]["offline"], false);
    assert_eq!(updated["capabilities"]["remoteBackup"], true);
}

#[tokio::test]
async fn workspace_security_downgrade_requires_confirmation_and_is_audited() {
    let f = Fixture::open();
    let (status, created) = f
        .request(&f.alice, "POST", "/workspaces", json!({"name":"等级回退"}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let path = format!("/workspaces/{id}");

    let (status, raised) = f
        .request(
            &f.alice,
            "PATCH",
            &path,
            json!({"securityLevel":"confidential"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{raised}");

    let (status, error) = f
        .request(
            &f.alice,
            "PATCH",
            &path,
            json!({"securityLevel":"internal"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(error["code"], "security_downgrade_confirmation_required");

    let (status, lowered) = f
        .request(
            &f.alice,
            "PATCH",
            &path,
            json!({"securityLevel":"internal","confirmSecurityDowngrade":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{lowered}");
    assert_eq!(lowered["securityLevel"], "internal");

    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    let (actor, action, result, metadata): (String, String, String, String) = db
        .query_row(
            "SELECT actor, action, result, metadata FROM product_audit
             WHERE workspace_id = ?1 AND action = 'workspace.security_level.change'
             ORDER BY id DESC LIMIT 1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(actor, "alice");
    assert_eq!(action, "workspace.security_level.change");
    assert_eq!(result, "ok");
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["from"], "confidential");
    assert_eq!(metadata["to"], "internal");
}

#[tokio::test]
async fn workspace_security_creation_accepts_public_and_secret_levels() {
    let f = Fixture::open();
    let (status, public) = f
        .request(
            &f.alice,
            "POST",
            "/workspaces",
            json!({"name":"公开空间","securityLevel":"public"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{public}");
    assert_eq!(public["securityLevel"], "public");
    assert_eq!(public["capabilities"]["publication"], true);
    assert_eq!(public["capabilities"]["anonymousShare"], true);
    assert_eq!(public["capabilities"]["externalAi"], true);

    let (status, secret) = f
        .request(
            &f.alice,
            "POST",
            "/workspaces",
            json!({"name":"高敏空间","securityLevel":"secret"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{secret}");
    assert_eq!(secret["securityLevel"], "secret");
    for capability in [
        "externalAi",
        "externalMcp",
        "anonymousShare",
        "publication",
        "offline",
        "remoteBackup",
    ] {
        assert_eq!(secret["capabilities"][capability], false, "{capability}");
    }
}

#[tokio::test]
async fn workspace_security_rejects_unknown_level() {
    let f = Fixture::open();
    let (status, created) = f
        .request(&f.alice, "POST", "/workspaces", json!({"name":"非法等级"}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let path = format!("/workspaces/{}", created["id"].as_str().unwrap());
    let (status, _) = f
        .request(
            &f.alice,
            "PATCH",
            &path,
            json!({"securityLevel":"top-secret"}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn v10_workspace_gains_internal_level_on_upgrade() {
    let mut f = Fixture::open();
    f.app = Router::new();
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch(
        "ALTER TABLE workspaces DROP COLUMN security_level;
         PRAGMA user_version=10;",
    )
    .unwrap();
    drop(db);

    f.restart();
    let (status, workspaces) = f.request(&f.alice, "GET", "/workspaces", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{workspaces}");
    let legacy = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "Legacy")
        .unwrap();
    assert_eq!(legacy["securityLevel"], "internal");
    assert_eq!(legacy["capabilities"]["publication"], false);
}

#[path = "workspaces/file_action_storage.rs"]
mod file_action_storage;

#[tokio::test]
async fn workspace_count_is_capped_per_account() {
    let f = Fixture::open();
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    for index in 0..10 {
        db.execute(
            "INSERT INTO workspaces (id, space_id, owner, origin, retention)
             VALUES (?1, ?2, 'alice', 'native', 'persistent')",
            rusqlite::params![format!("ws_{index:032x}"), format!("quota-space-{index}")],
        )
        .unwrap();
    }
    drop(db);

    let (status, error) = f
        .request(&f.alice, "POST", "/workspaces", json!({"name":"超出配额"}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "workspace_quota_exceeded");
}
