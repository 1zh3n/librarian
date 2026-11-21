use std::{collections::BTreeMap, fs, path::PathBuf};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

const OP: &str = "d377c2df-9e0e-4feb-9a73-9a175f33ffca";

struct Fixture {
    root: TempDir,
    tokens: BTreeMap<String, String>,
    app: Router,
    source: String,
    target: String,
}

impl Fixture {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = UserStore::create_empty(root.path()).unwrap();
        let mut tokens = BTreeMap::new();
        for user in [
            "admin",
            "reader",
            "source-only",
            "writer",
            "guest",
            "peer",
            "downgraded",
            "disabled-member",
        ] {
            store
                .create_sso_user(
                    user,
                    "test",
                    &format!("{user}@example.org"),
                    user == "admin",
                    Profile::default(),
                )
                .unwrap();
            tokens.insert(
                user.to_owned(),
                store.create_token(user, "fixture").unwrap(),
            );
        }
        store.set_disabled("disabled-member", true).unwrap();
        let config = json!({
            "source":{"name":"Source","access":"read","binding":{"prefix":"/source"},"revisions":"managed","members":{
                "reader":{"role":"read"},"source-only":{"role":"read"},"downgraded":{"role":"write"}}},
            "target":{"name":"Target","binding":{"prefix":"/target"},"revisions":"managed","spaceIgnore":"excluded/","members":{
                "reader":{"role":"write"},"writer":{"role":"write"},"guest":{"role":"read"},"disabled-member":{"role":"write"},"downgraded":{"role":"read"}}}
        });
        fs::write(root.path().join("spaces.json"), config.to_string()).unwrap();
        for p in [
            "source/field",
            "target/empty",
            "target/excluded/nested",
            "target/.private",
            "target/git-keys",
        ] {
            fs::create_dir_all(root.path().join("spaces").join(p)).unwrap();
        }
        fs::write(root.path().join("spaces/source/field/Note.md"), "原文\r\n").unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap().router();
        let mut f = Self {
            root,
            tokens,
            app,
            source: String::new(),
            target: String::new(),
        };
        let (status, list) = f.call("admin", "GET", "/workspaces", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        let id = |name| {
            list.as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == name)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        f.source = id("Source");
        f.target = id("Target");
        f
    }

    async fn call(
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
                    .header("authorization", format!("Bearer {}", self.tokens[user]))
                    .header("content-type", "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 262144).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    async fn action(&self, user: &str, endpoint: &str, input: Value) -> (StatusCode, Value) {
        self.call(
            user,
            "POST",
            &format!("/workspaces/{}/file-actions/{endpoint}", self.source),
            input,
        )
        .await
    }

    fn transfer(&self, action: &str) -> Value {
        json!({"action":action,"sourceKind":"document","sourcePath":"field/Note.md","targetWorkspace":self.target,"targetPath":"empty/Note.md"})
    }

    fn reconfigure(&mut self, update: impl FnOnce(&mut Value)) {
        self.app = Router::new();
        let path = self.root.path().join("spaces.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        update(&mut config);
        fs::write(&path, config.to_string()).unwrap();
        self.app = librarian::Product::open(self.root.path(), 0)
            .unwrap()
            .router();
    }

    fn files(&self, path: &str) -> PathBuf {
        self.root.path().join("spaces").join(path)
    }
}

#[tokio::test]
async fn preview_compares_effective_read_and_write_and_binds_member_identities() {
    let mut f = Fixture::open().await;
    let mut input = f.transfer("move");
    let (status, preview) = f.action("admin", "preview", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["fileCount"], 1);
    assert_eq!(
        preview["access"],
        json!({"gainedRead":1,"gainedWrite":1,"lost":1,"upgraded":1,"downgraded":1})
    );
    f.reconfigure(|config| {
        let members = &mut config["target"]["members"];
        members.as_object_mut().unwrap().remove("guest");
        members["peer"] = json!({"role":"read"});
    });
    let (_, second) = f.action("admin", "preview", input.clone()).await;
    assert_eq!(second["access"], preview["access"]);
    assert_ne!(second["token"], preview["token"]);
    input["operationId"] = json!(OP);
    input["token"] = preview["token"].clone();
    let (status, stale) = f.action("admin", "apply", input).await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["code"], "file_action_changed");
    assert!(f.files("source/field/Note.md").is_file());
    assert!(!f.files("target/empty/Note.md").exists());
}

#[tokio::test]
async fn copy_accepts_a_source_reader_and_rechecks_destination_permission() {
    let mut f = Fixture::open().await;
    let mut input = f.transfer("copy");
    let (status, preview) = f.action("reader", "preview", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(
        f.action("source-only", "preview", input.clone()).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.action("reader", "preview", f.transfer("move")).await.0,
        StatusCode::FORBIDDEN
    );
    input["operationId"] = json!(OP);
    input["token"] = preview["token"].clone();
    f.reconfigure(|config| config["target"]["members"]["reader"] = json!({"role":"read"}));
    let (status, denied) = f.action("reader", "apply", input).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert_eq!(denied["code"], "read_only");
    assert!(!f.files("target/empty/Note.md").exists());
}

#[tokio::test]
async fn folders_include_empty_children_and_enforce_write_scope_and_workspace_paths() {
    let f = Fixture::open().await;
    let path = format!("/workspaces/{}/folders", f.target);
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.files("source"), f.files("target/link")).unwrap();
    let (status, created) = f
        .call("reader", "POST", &path, json!({"path":"empty/子目录"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created, json!({"path":"empty/子目录"}));
    let (status, list) = f.call("guest", "GET", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["folders"], json!(["empty", "empty/子目录"]));
    let (status, denied) = f
        .call("guest", "POST", &path, json!({"path":"other"}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    let (status, conflict) = f
        .call("reader", "POST", &path, json!({"path":"empty"}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    for path_input in [
        "../escape",
        ".private/new",
        "git-keys/new",
        "excluded/new",
        "users.json/new",
    ] {
        let (status, rejected) = f
            .call("reader", "POST", &path, json!({"path":path_input}))
            .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{path_input} {rejected}"
        );
    }
}

#[tokio::test]
async fn stale_content_and_document_identity_leave_both_locations_intact() {
    let f = Fixture::open().await;
    let mut input = f.transfer("copy");
    let (status, list) = f
        .call(
            "admin",
            "GET",
            &format!("/workspaces/{}/documents", f.source),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    input["expectedDocumentId"] = list[0]["id"].clone();
    let (status, preview) = f.action("admin", "preview", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    fs::write(f.files("source/field/Note.md"), "another revision").unwrap();
    let mut apply = input.clone();
    apply["operationId"] = json!(OP);
    apply["token"] = preview["token"].clone();
    let (status, stale) = f.action("admin", "apply", apply).await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["code"], "file_action_changed");
    input["expectedDocumentId"] = json!("another-document-id");
    let (status, changed) = f.action("admin", "preview", input).await;
    assert_eq!(status, StatusCode::CONFLICT, "{changed}");
    assert_eq!(changed["code"], "file_action_changed");
    assert!(!f.files("target/empty/Note.md").exists());
}

#[tokio::test]
async fn replacing_the_selected_destination_folder_invalidates_the_preview() {
    let f = Fixture::open().await;
    let mut input = f.transfer("copy");
    let (status, preview) = f.action("admin", "preview", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    fs::rename(f.files("target/empty"), f.files("target/original-folder")).unwrap();
    fs::create_dir(f.files("target/empty")).unwrap();
    input["operationId"] = json!(OP);
    input["token"] = preview["token"].clone();
    let (status, stale) = f.action("admin", "apply", input).await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["code"], "file_action_changed");
    assert!(!f.files("target/empty/Note.md").exists());
    assert!(f.files("source/field/Note.md").is_file());
}

#[tokio::test]
async fn same_space_preview_returns_no_role_differences() {
    let f = Fixture::open().await;
    let (status, preview) = f.action("admin", "preview", json!({
        "action":"move", "sourceKind":"document", "sourcePath":"field/Note.md", "targetPath":"Archive.md"
    })).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(
        preview["access"],
        json!({"gainedRead":0,"gainedWrite":0,"lost":0,"upgraded":0,"downgraded":0})
    );
}

#[tokio::test]
async fn reader_copies_from_an_unversioned_source_to_a_managed_destination() {
    let mut f = Fixture::open().await;
    f.reconfigure(|config| config["source"]["revisions"] = json!("disabled"));
    let mut input = f.transfer("copy");
    let (status, preview) = f.action("reader", "preview", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    input["operationId"] = json!(OP);
    input["token"] = preview["token"].clone();
    let (status, copied) = f.action("reader", "apply", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{copied}");
    assert_eq!(copied["workspaceId"], f.target);
    assert_eq!(copied["path"], "empty/Note.md");
    assert!(copied["documentId"].is_string());
    let (status, retried) = f.action("reader", "apply", input).await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried, copied);
    assert_eq!(
        fs::read_to_string(f.files("target/empty/Note.md")).unwrap(),
        "原文\r\n"
    );
    assert_eq!(
        fs::read_to_string(f.files("source/field/Note.md")).unwrap(),
        "原文\r\n"
    );
}

#[tokio::test]
async fn file_in_destination_parent_returns_a_path_conflict() {
    let f = Fixture::open().await;
    fs::write(f.files("target/occupied.md"), "existing file").unwrap();
    let (status, error) = f
        .call(
            "reader",
            "POST",
            &format!("/workspaces/{}/folders", f.target),
            json!({"path":"occupied.md/new"}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "path_exists");
    assert_eq!(
        fs::read_to_string(f.files("target/occupied.md")).unwrap(),
        "existing file"
    );
}

#[tokio::test]
async fn restart_keeps_other_workspaces_available_when_transfer_destination_retires() {
    for published in [false, true] {
        let mut f = Fixture::open().await;
        let mut input = f.transfer("move");
        let (status, preview) = f.action("admin", "preview", input.clone()).await;
        assert_eq!(status, StatusCode::OK, "{preview}");
        input["token"] = preview["token"].clone();
        input["operationId"] = OP.into();
        let db =
            rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
        let blocked = if published { &f.source } else { &f.target };
        db.execute_batch(&format!(
            "CREATE TRIGGER interrupt_action BEFORE INSERT ON mutations WHEN NEW.workspace_id = '{blocked}' BEGIN SELECT RAISE(FAIL,'test interruption'); END;"
        )).unwrap();
        let (status, error) = f.action("admin", "apply", input).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{error}");
        db.execute_batch("DROP TRIGGER interrupt_action").unwrap();
        drop(db);
        f.reconfigure(|config| {
            config.as_object_mut().unwrap().remove("target");
        });
        let (status, workspaces) = f.call("admin", "GET", "/workspaces", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{workspaces}");
        assert!(workspaces
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == f.source));
        assert_eq!(
            fs::read_to_string(f.files("source/field/Note.md")).unwrap(),
            "原文\r\n"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn folder_picker_lists_readable_siblings_of_an_unreadable_folder() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::open().await;
    let private = f.files("target/locked");
    fs::create_dir(&private).unwrap();
    fs::set_permissions(&private, fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = fs::read_dir(&private).is_err();
    let (status, listed) = f
        .call(
            "admin",
            "GET",
            &format!("/workspaces/{}/folders", f.target),
            Value::Null,
        )
        .await;
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(status, StatusCode::OK, "{listed}");
    let folders = listed["folders"].as_array().unwrap();
    assert!(folders.iter().any(|value| value == "empty"));
    if unreadable {
        assert!(folders.iter().all(|value| value != "locked"));
    }
}

#[tokio::test]
async fn selected_folder_id_binds_preview_and_rename_to_the_original_directory_row() {
    let f = Fixture::open().await;
    let path = format!("/workspaces/{}/folders", f.source);
    let (status, listed) = f.call("admin", "GET", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let id = listed["identities"]["field"]
        .as_str()
        .expect("folder row identity");
    let mut input = json!({"action":"move", "sourceKind":"folder", "sourcePath":"field",
                           "targetPath":"renamed", "expectedFolderId":id});
    fs::write(
        f.files("source/field/extra.txt"),
        "added inside the same folder",
    )
    .unwrap();
    let (status, preview) = f.action("admin", "preview", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    fs::rename(f.files("source/field"), f.files("source/original")).unwrap();
    fs::create_dir(f.files("source/field")).unwrap();
    fs::write(f.files("source/field/Replacement.md"), "keep this").unwrap();
    for (action, destination) in [
        ("move", Some("renamed")),
        ("copy", Some("copy")),
        ("delete", None),
    ] {
        let mut request = json!({"action":action,"sourceKind":"folder","sourcePath":"field","expectedFolderId":id});
        if let Some(dst) = destination {
            request["targetPath"] = json!(dst);
        }
        let (status, error) = f.action("admin", "preview", request).await;
        assert_eq!(status, StatusCode::CONFLICT, "{action} {error}");
        assert_eq!(error["code"], "file_action_changed");
    }
    input["operationId"] = OP.into();
    input["token"] = preview["token"].clone();
    let (status, error) = f.action("admin", "apply", input).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "file_action_changed");
    let (_, current) = f.call("admin", "GET", &path, Value::Null).await;
    assert_ne!(current["identities"]["field"], id);
    assert_ne!(current["identities"]["original"], id);
    assert!(f.files("source/original/Note.md").is_file());
    assert!(f.files("source/field/Replacement.md").is_file());
    assert!(!f.files("source/renamed").exists());
}
