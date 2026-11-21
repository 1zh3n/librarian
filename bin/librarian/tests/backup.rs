use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGINAL: &str = "\u{feff}手记\r\n尾空格  \r";

struct Fixture {
    _root: TempDir,
    data: PathBuf,
    remote: PathBuf,
    distractor: PathBuf,
    router: Router,
    owner: String,
    member: String,
    workspace: String,
}

impl Fixture {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let local = data.join("spaces/left");
        let remote = root.path().join("backup.git");
        let distractor = root.path().join("external-source.git");
        fs::create_dir_all(&local).unwrap();
        for repo in [&remote, &distractor] {
            fs::create_dir(repo).unwrap();
            git(repo, &["init", "--bare"]);
        }
        fs::write(local.join("First.md"), ORIGINAL).unwrap();
        fs::write(local.join("Attachment.png"), [137, 80, 78, 71, 0, 255]).unwrap();
        let users = UserStore::create_empty(&data).unwrap();
        let token = |username, admin| {
            users
                .create_user(username, "only-a-test-password", admin, Profile::default())
                .unwrap();
            users.create_token(username, "backup-test").unwrap()
        };
        let owner = token("owner", true);
        let member = token("member", false);
        fs::write(
            data.join("spaces.json"),
            json!({
                "left": {"name":"Left", "binding":{"prefix":"/left"}, "revisions":"managed",
                    "members":{"owner":{"role":"write"},"member":{"role":"write"}},
                    "revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300}}
            })
            .to_string(),
        )
        .unwrap();
        let product = librarian::Product::open(&data, 0).unwrap();
        product
            .manager()
            .instance("left")
            .unwrap()
            .revisions
            .as_ref()
            .unwrap()
            .snapshot_now()
            .unwrap();
        git(
            &local,
            &["remote", "add", "origin", distractor.to_str().unwrap()],
        );
        let router = product.router();
        let (_, workspaces) = request(&router, &owner, "GET", "/workspaces", Value::Null).await;
        let workspace = workspaces[0]["id"].as_str().unwrap().to_owned();
        write_target(&data, &remote, Some(&workspace));
        Self {
            _root: root,
            data,
            remote,
            distractor,
            router,
            owner,
            member,
            workspace,
        }
    }

    fn local(&self) -> PathBuf {
        self.data.join("spaces/left")
    }

    fn restart(&mut self) {
        self.router = Router::new();
        self.router = librarian::Product::open(&self.data, 0).unwrap().router();
    }

    async fn call(&self, method: &str, path: &str, input: Value) -> (StatusCode, Value) {
        request(
            &self.router,
            &self.owner,
            method,
            &format!("/workspaces/{}{path}", self.workspace),
            input,
        )
        .await
    }

    async fn configure(&self, mode: &str) {
        let (status, configured) = self
            .call("PUT", "/backup", json!({"targetId":"safe","mode":mode}))
            .await;
        assert_eq!(status, StatusCode::OK, "{configured}");
        assert_eq!(
            configured["targets"],
            json!([{"id":"safe","label":"Workspace Backup"}])
        );
        assert_eq!(configured["targetId"], "safe");
        assert_eq!(configured["mode"], mode);
    }

    async fn local_move(&self, from: &str, to: &str, operation: &str) -> Value {
        let (status, updated) = self
            .call(
                "POST",
                "/rename",
                json!({"operationId":operation,"from":from,"to":to}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{updated}");
        updated["commitId"].clone()
    }

    async fn job(&self, operation: &str) -> Value {
        let (status, job) = self
            .call("POST", "/backup/jobs", json!({"operationId":operation}))
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{job}");
        assert_eq!(job["id"], operation);
        job
    }
}

async fn request(
    app: &Router,
    token: &str,
    method: &str,
    path: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/api/v1{path}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let body = to_bytes(body, 1_000_000).await.unwrap();
    (
        parts.status,
        serde_json::from_slice(&body).unwrap_or_default(),
    )
}

fn git(repo: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn write_target(data: &Path, remote: &Path, workspace: Option<&str>) {
    let mut target = json!({
        "id": "safe", "label": "Workspace Backup", "repository": remote, "branch": "workspace-backup"
    });
    if let Some(workspace) = workspace {
        target["workspaceId"] = json!(workspace);
    }
    fs::write(
        data.join(".librarian/backup-targets.json"),
        json!({"targets": [target]}).to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn backup_lists_only_the_workspace_binding_and_ignores_legacy_targets() {
    let f = Fixture::open().await;
    f.configure("grouped").await;
    let (status, created) = request(
        &f.router,
        &f.member,
        "POST",
        "/workspaces",
        json!({"name": "Independent Workspace"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let other = created["id"].as_str().unwrap();
    let path = format!("/workspaces/{other}/backup");
    let (status, view) = request(&f.router, &f.member, "GET", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["targets"], json!([]));
    assert_eq!(view["targetId"], Value::Null);
    let (status, rejected) = request(
        &f.router,
        &f.member,
        "PUT",
        &path,
        json!({"targetId": "safe", "mode": "grouped"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");

    write_target(&f.data, &f.remote, None);
    let (status, view) = f.call("GET", "/backup", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["targets"], json!([]));
    assert_eq!(view["targetId"], Value::Null);
    let (status, rejected) = f
        .call(
            "POST",
            "/backup/jobs",
            json!({"operationId": "b5bb7617-62ac-4b1f-b53c-be4f1b73e967"}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
    assert!(git(&f.remote, &["for-each-ref"]).is_empty());
}

#[tokio::test]
async fn backup_rechecks_the_binding_before_retrying_a_job() {
    let f = Fixture::open().await;
    f.configure("grouped").await;
    let unavailable = f.remote.with_extension("offline");
    fs::rename(&f.remote, &unavailable).unwrap();
    let operation = "c7f9c664-48df-44c7-b223-d254f0297cf1";
    let failed = f.job(operation).await;
    assert_eq!(failed["status"], "failed");
    fs::rename(&unavailable, &f.remote).unwrap();

    let (status, created) = request(
        &f.router,
        &f.member,
        "POST",
        "/workspaces",
        json!({"name": "Replacement Workspace"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    write_target(&f.data, &f.remote, created["id"].as_str());
    let (status, rejected) = f
        .call("POST", "/backup/jobs", json!({"operationId": operation}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
    assert!(git(&f.remote, &["for-each-ref"]).is_empty());

    write_target(&f.data, &f.remote, Some(&f.workspace));
    let retried = f.job(operation).await;
    assert_eq!(retried["status"], "succeeded", "{retried}");
    assert_eq!(retried["sourceCommitId"], failed["sourceCommitId"]);
    write_target(&f.data, &f.remote, created["id"].as_str());
    let (status, rejected) = f
        .call("POST", "/backup/jobs", json!({"operationId": operation}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
}

#[tokio::test]
async fn configured_backup_batches_or_copies_operations_without_changing_source_history() {
    let f = Fixture::open().await;
    f.configure("grouped").await;
    let initial = git(&f.local(), &["rev-parse", "HEAD"]);
    let first = f.job("79b5e6f5-c80c-4d65-88f6-9e264e8d9c4e").await;
    assert_eq!(first["status"], "succeeded", "{first}");
    assert_eq!(
        first["sourceCommitId"],
        String::from_utf8_lossy(&initial).trim()
    );
    assert_ne!(first["commitId"], first["sourceCommitId"]);
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup:First.md"]),
        ORIGINAL.as_bytes()
    );
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup:Attachment.png"]),
        [137, 80, 78, 71, 0, 255]
    );
    assert_eq!(git(&f.local(), &["rev-parse", "HEAD"]), initial);

    let delivered = f
        .call(
            "POST",
            "/deliveries",
            json!({
                "manifest":{"deliveryId":"project","sourceName":f.distractor},
                "files":[{"path":"Intro.md","contentBase64":"dGV4dAo="}]
            }),
        )
        .await;
    assert_eq!(delivered.0, StatusCode::CREATED, "{}", delivered.1);
    let second_source = f
        .local_move(
            "First.md",
            "Grouped.md",
            "e1f463bc-af05-4257-9ecd-abb3fd3fa888",
        )
        .await;
    let second = f.job("03b2a9fd-56cd-4df6-9649-1124b25b354b").await;
    assert_eq!(second["status"], "succeeded", "{second}");
    assert_eq!(second["sourceCommitId"], second_source);
    assert_eq!(
        git(&f.remote, &["rev-list", "--count", "workspace-backup"]),
        b"2\n"
    );
    assert_eq!(
        git(
            &f.remote,
            &["show", "workspace-backup:deliveries/project/Intro.md"]
        ),
        b"text\n"
    );

    f.configure("each-operation").await;
    let third_operation = "284397c0-3a20-4f65-905a-419419db39a4";
    let fourth_operation = "36f83aee-b0d9-4e86-bd65-830fcf300a0c";
    f.local_move("Grouped.md", "One.md", third_operation).await;
    let final_source = f.local_move("One.md", "Two.md", fourth_operation).await;
    let final_job = f.job("53e4b569-a114-40b6-b133-76cc75418046").await;
    assert_eq!(final_job["status"], "succeeded", "{final_job}");
    assert_eq!(final_job["sourceCommitId"], final_source);
    assert_eq!(
        git(&f.remote, &["rev-list", "--count", "workspace-backup"]),
        b"4\n"
    );
    let log = String::from_utf8(git(
        &f.remote,
        &["log", "-2", "--format=%B", "workspace-backup"],
    ))
    .unwrap();
    assert!(
        log.contains(third_operation) && log.contains(fourth_operation),
        "{log}"
    );
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup~1:One.md"]),
        ORIGINAL.as_bytes()
    );
    assert_eq!(
        git(&f.local(), &["rev-parse", "HEAD"]),
        format!("{}\n", final_source.as_str().unwrap()).as_bytes()
    );
    assert_eq!(
        git(&f.local(), &["remote", "get-url", "origin"]),
        format!("{}\n", f.distractor.display()).as_bytes()
    );
    assert!(git(&f.distractor, &["for-each-ref"]).is_empty());
}

#[tokio::test]
async fn unavailable_remote_retries_the_original_source_and_fresh_jobs_can_follow() {
    let f = Fixture::open().await;
    f.configure("grouped").await;
    let unavailable = f.remote.with_extension("offline");
    fs::rename(&f.remote, &unavailable).unwrap();
    let operation = "ecaec34e-4344-45f1-a747-eb717fce9346";
    let failed = f.job(operation).await;
    assert_eq!(failed["status"], "failed", "{failed}");
    assert!(failed["sourceCommitId"].is_string());
    assert!(!failed.to_string().contains(f.remote.to_str().unwrap()));
    let latest = f
        .local_move(
            "First.md",
            "Later.md",
            "d7c8f309-3e31-4c0f-88d9-3323e412b1a2",
        )
        .await;
    assert_ne!(latest, failed["sourceCommitId"]);
    assert_eq!(
        fs::read(f.local().join("Later.md")).unwrap(),
        ORIGINAL.as_bytes()
    );
    fs::rename(&unavailable, &f.remote).unwrap();
    let retried = f.job(operation).await;
    assert_eq!(retried["status"], "succeeded", "{retried}");
    assert_eq!(retried["sourceCommitId"], failed["sourceCommitId"]);
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup:First.md"]),
        ORIGINAL.as_bytes()
    );
    let current = f.job("179972ac-34d0-402e-a085-3c920103c3ea").await;
    assert_eq!(current["status"], "succeeded", "{current}");
    assert_eq!(current["sourceCommitId"], latest);
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup:Later.md"]),
        ORIGINAL.as_bytes()
    );
}

#[tokio::test]
async fn retry_after_result_loss_reconciles_the_remote_ref_after_restart() {
    let mut f = Fixture::open().await;
    f.configure("grouped").await;
    let db = rusqlite::Connection::open(f.data.join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER lost_backup_result BEFORE UPDATE OF status ON backup_jobs
                     WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'result lost'); END;",
    )
    .unwrap();
    let operation = "cde0d116-7d07-4bbb-a40e-a3433e9103c0";
    let (status, result) = f
        .call("POST", "/backup/jobs", json!({"operationId":operation}))
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{result}");
    let accepted = String::from_utf8(git(
        &f.remote,
        &["rev-parse", "refs/heads/workspace-backup"],
    ))
    .unwrap();
    db.execute_batch("DROP TRIGGER lost_backup_result").unwrap();
    drop(db);
    f.restart();
    let retried = f.job(operation).await;
    assert_eq!(retried["status"], "succeeded", "{retried}");
    assert_eq!(retried["commitId"], accepted.trim());
    assert_eq!(
        git(&f.remote, &["rev-list", "--count", "workspace-backup"]),
        b"1\n"
    );
    assert_eq!(
        f.call("GET", &format!("/backup/jobs/{operation}"), Value::Null)
            .await,
        (StatusCode::OK, retried.clone())
    );
    assert_eq!(f.job(operation).await, retried);
}

#[tokio::test]
async fn backup_requires_management_and_does_not_adopt_an_existing_remote_branch() {
    let f = Fixture::open().await;
    let (status, result) = request(
        &f.router,
        &f.member,
        "GET",
        &format!("/workspaces/{}/backup", f.workspace),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    let (status, result) = f
        .call(
            "PUT",
            "/backup",
            json!({"targetId":"other","mode":"grouped","repository":f.distractor}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{result}");
    f.configure("grouped").await;
    git(
        &f.local(),
        &[
            "push",
            f.remote.to_str().unwrap(),
            "HEAD:refs/heads/workspace-backup",
        ],
    );
    let existing = git(&f.remote, &["rev-parse", "refs/heads/workspace-backup"]);
    let failed = f.job("d17ccada-16be-42c5-828d-59a7f0160e48").await;
    assert_eq!(failed["status"], "failed", "{failed}");
    assert_eq!(
        git(&f.remote, &["rev-parse", "refs/heads/workspace-backup"]),
        existing
    );
}

#[cfg(unix)]
#[tokio::test]
async fn backup_push_keeps_its_revision_while_local_managed_writes_continue() {
    use std::{os::unix::fs::PermissionsExt, time::Duration};

    let f = Fixture::open().await;
    f.configure("grouped").await;
    let hook = f.remote.join("hooks/pre-receive");
    fs::write(
        &hook,
        r#"#!/bin/sh
touch receive-started
i=0
while [ ! -f receive-unblocked ] && [ "$i" -lt 120 ]; do
  sleep 0.05
  i=$((i+1))
done
test -f receive-unblocked
"#,
    )
    .unwrap();
    fs::set_permissions(hook, fs::Permissions::from_mode(0o700)).unwrap();
    let (router, owner, workspace) = (f.router.clone(), f.owner.clone(), f.workspace.clone());
    let worker = tokio::spawn(async move {
        request(
            &router,
            &owner,
            "POST",
            &format!("/workspaces/{workspace}/backup/jobs"),
            json!({"operationId":"a8b4b90a-eaf7-4d1c-8057-8dad5bf112a7"}),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(4), async {
        while !f.remote.join("receive-started").exists() {
            assert!(
                !worker.is_finished(),
                "The Git push exited before reaching the remote hook"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Real Git receive started");
    let duplicate = f.job("a8b4b90a-eaf7-4d1c-8057-8dad5bf112a7").await;
    assert_eq!(duplicate["status"], "queued");
    let revision = tokio::time::timeout(
        Duration::from_secs(3),
        f.local_move(
            "First.md",
            "DuringPush.md",
            "03a09621-d205-4a4b-8d4a-5ca3edb3fd7e",
        ),
    )
    .await;
    fs::write(f.remote.join("receive-unblocked"), "ok").unwrap();
    let revision = revision.expect("Git transport must not hold the Workspace write lock");
    let (status, job) = worker.await.unwrap();
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["status"], "succeeded", "{job}");
    assert_ne!(job["sourceCommitId"], revision);
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup:First.md"]),
        ORIGINAL.as_bytes()
    );
    assert_eq!(
        fs::read(f.local().join("DuringPush.md")).unwrap(),
        ORIGINAL.as_bytes()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn inherited_git_rewrite_cannot_redirect_backup() {
    const CHILD: &str = "LIBRARIAN_BACKUP_REWRITE_TEST_PROCESS";
    if std::env::var_os(CHILD).is_none() {
        let scope = tempfile::tempdir().unwrap();
        let redirected = scope.path().join("does-not-exist");
        let executable = std::env::current_exe().unwrap();
        let result = Command::new(executable)
            .args([
                "--exact",
                "inherited_git_rewrite_cannot_redirect_backup",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("TMPDIR", scope.path())
            .env("GIT_CONFIG_COUNT", "1")
            .env(
                "GIT_CONFIG_KEY_0",
                format!("url.file://{}.insteadOf", redirected.display()),
            )
            .env("GIT_CONFIG_VALUE_0", scope.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let f = Fixture::open().await;
    assert!(
        String::from_utf8(git(&f.local(), &["remote", "get-url", "origin"]))
            .unwrap()
            .contains("does-not-exist")
    );
    f.configure("grouped").await;
    let confirmed = f.job("19d21a8d-9c6c-4ad4-b643-381f7ce05dc4").await;
    assert_eq!(confirmed["status"], "succeeded", "{confirmed}");
    assert_eq!(
        git(&f.remote, &["show", "workspace-backup:First.md"]),
        ORIGINAL.as_bytes()
    );
    assert!(git(&f.distractor, &["for-each-ref"]).is_empty());
}
