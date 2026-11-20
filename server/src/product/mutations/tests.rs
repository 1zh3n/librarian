use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
};
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;
use tempfile::TempDir;
use tower::ServiceExt;

use crate::{
    multi::users::{Profile, UserStore},
    product::{auth::Account, documents::DocumentService, space_adapter::NativeSpaces},
};

use super::{apply_with_checkpoint, ApiError, Checkpoint, MutationEdit};

const ORIGINAL: [&str; 2] = ["\u{feff}前稿 A\r\n", "前稿 B  \n"];
const UPDATED: [&str; 2] = ["AI 第一次写入 A\r\n", "AI 第一次写入 B  \n"];
const PATHS: [&str; 2] = ["A.md", "B.md"];
const OPERATION: &str = "019b9c24-d9ef-7f08-b41f-4c524a91cb4c";
const SPACE: &str = "field";

struct Fixture {
    root: TempDir,
    token: String,
    workspace: String,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        users
            .create_user(
                "writer",
                "mutation-test-password",
                false,
                Profile::default(),
            )
            .unwrap();
        let token = users.create_token("writer", "test token").unwrap();
        let repo = repository(root.path());
        fs::create_dir_all(&repo).unwrap();
        for (path, markdown) in PATHS.into_iter().zip(ORIGINAL) {
            fs::write(repo.join(path), markdown).unwrap();
        }
        fs::write(
            root.path().join("spaces.json"),
            json!({
                SPACE: {"name":"Field","binding":{"prefix":"/field"},"access":"none",
                        "members":{"writer":{"role":"write"}},"revisions":"managed",
                        "revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300}}
            })
            .to_string(),
        )
        .unwrap();
        let service = open(root.path());
        let workspace = service.metadata.workspace_id(SPACE).unwrap();
        let instance = service.spaces.manager.instance(SPACE).unwrap();
        instance.revisions.as_ref().unwrap().snapshot_now().unwrap();
        assert_eq!(git(&repo, &["rev-list", "--count", "HEAD"]), "1\n");
        Self {
            root,
            token,
            workspace,
        }
    }

    fn open(&self) -> DocumentService {
        open(self.root.path())
    }

    fn repo(&self) -> PathBuf {
        repository(self.root.path())
    }

    fn contents(&self) -> [String; 2] {
        PATHS.map(|name| fs::read_to_string(self.repo().join(name)).unwrap())
    }

    fn crash(&self, point: &str) {
        let output = self.crash_command(point).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(86),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn crash_command(&self, point: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "product::mutations::tests::mutation_crash_worker",
            ])
            .env("LIBRARIAN_TEST_CRASH_ROOT", self.root.path())
            .env("LIBRARIAN_TEST_CRASH_TOKEN", &self.token)
            .env("LIBRARIAN_TEST_CRASH_WORKSPACE", &self.workspace)
            .env("LIBRARIAN_TEST_CRASH_POINT", point)
            .stdin(Stdio::null());
        command
    }
}

fn repository(root: &Path) -> PathBuf {
    root.join("spaces").join(SPACE)
}

fn open(root: &Path) -> DocumentService {
    let spaces = NativeSpaces::open(root, 0, "test").unwrap();
    DocumentService::open(root, spaces).unwrap()
}

fn account(service: &DocumentService, token: &str) -> Account {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    Account::authenticate(&service.spaces, &headers, true).unwrap()
}

fn edits() -> Vec<MutationEdit> {
    PATHS
        .into_iter()
        .zip(ORIGINAL)
        .zip(UPDATED)
        .map(|((path, original), markdown)| MutationEdit {
            path: path.to_owned(),
            base_revision: Some(sha256_hex(original.as_bytes())),
            markdown: Some(markdown.to_owned()),
        })
        .collect()
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

async fn document(router: axum::Router, token: String, id: String) -> Value {
    let response = router
        .oneshot(
            Request::get(format!("/documents/{id}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap()
}

#[tokio::test]
async fn second_write_failure_leaves_no_partial_read() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.open());
    let id = service
        .metadata
        .document_id(&fixture.workspace, PATHS[0])
        .unwrap();
    let router = crate::product::documents::routes(service.clone());
    let (is_writing, started) = tokio::sync::oneshot::channel();
    let (release, allow_rollback) = std::sync::mpsc::channel();
    let token = fixture.token.clone();
    let workspace = fixture.workspace.clone();
    let repo = fixture.repo();
    let mut is_writing = Some(is_writing);
    let writer = tokio::task::spawn_blocking(move || {
        let account = account(&service, &token);
        apply_with_checkpoint(
            &service,
            &account,
            &workspace,
            OPERATION,
            edits(),
            |point| {
                if point == Checkpoint::BeforeWrite(1) {
                    assert_eq!(fs::read_to_string(repo.join(PATHS[0])).unwrap(), UPDATED[0]);
                    assert_eq!(
                        fs::read_to_string(repo.join(PATHS[1])).unwrap(),
                        ORIGINAL[1]
                    );
                    is_writing.take().unwrap().send(()).unwrap();
                    allow_rollback
                        .recv_timeout(Duration::from_secs(10))
                        .unwrap();
                    return Err(ApiError::internal("test write failure"));
                }
                Ok(())
            },
        )
    });
    started.await.unwrap();
    let mut reader = tokio::spawn(document(router, fixture.token.clone(), id));
    let result = tokio::time::timeout(Duration::from_millis(150), &mut reader).await;
    release.send(()).unwrap();
    assert!(result.is_err(), "reader saw unfinished write: {result:?}");
    assert_eq!(
        writer.await.unwrap().unwrap_err().into_response().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(reader.await.unwrap()["markdown"], ORIGINAL[0]);
    assert_eq!(fixture.contents(), ORIGINAL);
    assert_eq!(
        git(&fixture.repo(), &["rev-list", "--count", "HEAD"]),
        "1\n"
    );
}

#[tokio::test]
async fn foreign_worktree_change_is_preserved() {
    let fixture = Fixture::new();
    let service = fixture.open();
    let account = account(&service, &fixture.token);
    let external = "域外编辑器的更新\n";
    let error = apply_with_checkpoint(
        &service,
        &account,
        &fixture.workspace,
        OPERATION,
        edits(),
        |point| {
            if point == Checkpoint::BeforePublish {
                fs::write(fixture.repo().join(PATHS[0]), external).unwrap();
                return Err(ApiError::internal("test write failure"));
            }
            Ok(())
        },
    )
    .unwrap_err()
    .into_response();
    assert_eq!(error.status(), StatusCode::CONFLICT);
    assert_eq!(fixture.contents(), [external, ORIGINAL[1]]);
    assert_eq!(
        git(&fixture.repo(), &["rev-list", "--count", "HEAD"]),
        "1\n"
    );
    drop(service);
    let reopened = fixture.open();
    assert_eq!(
        apply_with_checkpoint(
            &reopened,
            &account,
            &fixture.workspace,
            OPERATION,
            edits(),
            |_| Ok(())
        )
        .unwrap_err()
        .into_response()
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fixture.contents(), [external, ORIGINAL[1]]);
}

#[tokio::test]
async fn incomplete_rollback_keeps_partial_workspace_hidden() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.open());
    let user = account(&service, &fixture.token);
    let id = service
        .metadata
        .document_id(&fixture.workspace, PATHS[0])
        .unwrap();
    let backup = service.metadata.operation_directory(OPERATION).join("0");
    let error = apply_with_checkpoint(
        &service,
        &user,
        &fixture.workspace,
        OPERATION,
        edits(),
        |point| {
            if point == Checkpoint::BeforeWrite(1) {
                fs::write(&backup, "damaged recovery copy").unwrap();
                return Err(ApiError::internal("test write failure"));
            }
            Ok(())
        },
    )
    .unwrap_err()
    .into_response();
    assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(fixture.contents(), [UPDATED[0], ORIGINAL[1]]);
    let response = crate::product::documents::routes(service.clone())
        .oneshot(
            Request::get(format!("/documents/{id}"))
                .header("authorization", format!("Bearer {}", fixture.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    fs::write(backup, ORIGINAL[0]).unwrap();
    drop(service);
    let _reopened = fixture.open();
    assert_eq!(fixture.contents(), ORIGINAL);
}

#[tokio::test]
async fn crash_before_commit_rolls_back() {
    let fixture = Fixture::new();
    let initial = git(&fixture.repo(), &["rev-parse", "HEAD"]);
    fixture.crash("before");
    assert_eq!(fixture.contents(), UPDATED);
    assert_eq!(git(&fixture.repo(), &["rev-parse", "HEAD"]), initial);
    let service = fixture.open();
    assert_eq!(fixture.contents(), ORIGINAL);
    assert_eq!(git(&fixture.repo(), &["rev-parse", "HEAD"]), initial);
    let account = account(&service, &fixture.token);
    let receipt = apply_with_checkpoint(
        &service,
        &account,
        &fixture.workspace,
        OPERATION,
        edits(),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(fixture.contents(), UPDATED);
    assert_eq!(
        git(&fixture.repo(), &["rev-parse", "HEAD"]).trim(),
        receipt.commit_id
    );
    assert_eq!(
        git(&fixture.repo(), &["rev-list", "--count", "HEAD"]),
        "2\n"
    );
}

#[tokio::test]
async fn crash_after_commit_recovers_same_receipt() {
    let fixture = Fixture::new();
    fs::write(fixture.repo().join("Unrelated.md"), "保留已暂存的文件").unwrap();
    git(&fixture.repo(), &["add", "--", "Unrelated.md"]);
    fixture.crash("after");
    let committed = git(&fixture.repo(), &["rev-parse", "HEAD"]);
    let service = fixture.open();
    let account = account(&service, &fixture.token);
    let receipt = apply_with_checkpoint(
        &service,
        &account,
        &fixture.workspace,
        OPERATION,
        edits(),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(receipt.commit_id, committed.trim());
    assert_eq!(receipt.operation_id, OPERATION);
    assert_eq!(receipt.workspace_id, fixture.workspace);
    assert_eq!(fixture.contents(), UPDATED);
    assert_eq!(
        git(&fixture.repo(), &["rev-list", "--count", "HEAD"]),
        "2\n"
    );
    assert_eq!(
        git(&fixture.repo(), &["diff", "--cached", "--name-only"]),
        "Unrelated.md\n"
    );
    assert!(git(&fixture.repo(), &["log", "-1", "--format=%B"])
        .contains(&format!("Librarian-Operation-Id: {OPERATION}")));
    for (path, expected) in PATHS.into_iter().zip(UPDATED) {
        assert_eq!(
            git(&fixture.repo(), &["show", &format!("HEAD:{path}")]),
            expected
        );
    }
}

#[tokio::test]
async fn recovery_rebuilds_a_missing_git_index_copy() {
    let fixture = Fixture::new();
    fs::write(fixture.repo().join("Unrelated.md"), "keep staged").unwrap();
    git(&fixture.repo(), &["add", "--", "Unrelated.md"]);
    fixture.crash("after_index_lost");
    let _reopened = fixture.open();
    assert_eq!(fixture.contents(), UPDATED);
    assert_eq!(
        git(&fixture.repo(), &["diff", "--cached", "--name-only"]),
        "Unrelated.md\n"
    );
    assert!(!fixture.repo().join(".git/index.lock").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn an_update_ref_child_cannot_publish_after_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let head = git(&fixture.repo(), &["rev-parse", "HEAD"]);
    let wrapper = tempfile::tempdir().unwrap();
    let script = wrapper.path().join("git");
    fs::write(
        &script,
        r#"#!/bin/sh
is_update=
uses_stdin=
for arg do
  [ "$arg" = update-ref ] && is_update=1
  [ "$arg" = --stdin ] && uses_stdin=1
done
if [ -n "$is_update" ]; then
  command_file="$WRAP_DIR/commands.$$"
  cat > "$command_file"
  if [ -z "$uses_stdin" ] || grep -q '^update refs/heads/' "$command_file"; then
    touch "$WRAP_DIR/waiting"
    for count in $(seq 1 500); do
      [ -e "$WRAP_DIR/release" ] && break
      sleep 0.02
    done
    [ -e "$WRAP_DIR/release" ] || exit 92
    "$REAL_GIT" "$@" < "$command_file"
    result=$?
    printf '%s\n' "$result" > "$WRAP_DIR/result"
    exit "$result"
  fi
  exec "$REAL_GIT" "$@" < "$command_file"
fi
exec "$REAL_GIT" "$@"
"#,
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let search_path = std::env::var_os("PATH").unwrap();
    let real = std::env::split_paths(&search_path)
        .map(|folder| folder.join("git"))
        .find(|candidate| candidate.is_file())
        .unwrap();
    let path = std::env::join_paths(
        std::iter::once(wrapper.path().to_owned()).chain(std::env::split_paths(&search_path)),
    )
    .unwrap();
    let mut worker = fixture
        .crash_command("publisher")
        .env("PATH", path)
        .env("REAL_GIT", real)
        .env("WRAP_DIR", wrapper.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let wait = |name| {
        let file = wrapper.path().join(name);
        let deadline = std::time::Instant::now() + Duration::from_secs(7);
        while !file.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        file
    };
    let paused = wait("waiting").exists();
    worker.kill().unwrap();
    worker.wait().unwrap();
    assert!(
        paused,
        "Git publisher did not reach its interposition point"
    );
    assert_eq!(fixture.contents(), UPDATED);

    let reopened = fixture.open();
    assert_eq!(fixture.contents(), ORIGINAL);
    fs::write(wrapper.path().join("release"), "").unwrap();
    let result = fs::read_to_string(wait("result")).unwrap();
    assert_ne!(
        result.trim(),
        "0",
        "surviving Git child published the old operation"
    );
    assert_eq!(git(&fixture.repo(), &["rev-parse", "HEAD"]), head);
    let account = account(&reopened, &fixture.token);
    let retry = apply_with_checkpoint(
        &reopened,
        &account,
        &fixture.workspace,
        OPERATION,
        edits(),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(
        git(&fixture.repo(), &["rev-parse", "HEAD"]).trim(),
        retry.commit_id
    );
}

#[tokio::test]
#[ignore = "only invoked as a child by the restart tests"]
async fn mutation_crash_worker() {
    let root = std::env::var_os("LIBRARIAN_TEST_CRASH_ROOT").unwrap();
    let service = open(Path::new(&root));
    let account = account(
        &service,
        &std::env::var("LIBRARIAN_TEST_CRASH_TOKEN").unwrap(),
    );
    let workspace = std::env::var("LIBRARIAN_TEST_CRASH_WORKSPACE").unwrap();
    let phase = std::env::var("LIBRARIAN_TEST_CRASH_POINT").unwrap();
    let desired = match phase.as_str() {
        "before" => Some(Checkpoint::BeforePublish),
        "after" | "after_index_lost" => Some(Checkpoint::AfterPublish),
        "publisher" => None,
        other => panic!("Unknown crash point {other}"),
    };
    apply_with_checkpoint(
        &service,
        &account,
        &workspace,
        OPERATION,
        edits(),
        |point| {
            if Some(point) == desired {
                if phase == "after_index_lost" {
                    let git = repository(Path::new(&root)).join(".git");
                    let scratch = fs::read_dir(git)
                        .unwrap()
                        .map(Result::unwrap)
                        .find(|entry| entry.file_name().to_string_lossy().ends_with("-working"))
                        .unwrap();
                    fs::remove_file(scratch.path()).unwrap();
                }
                std::process::exit(86);
            }
            Ok(())
        },
    )
    .unwrap();
    panic!("Expected an interrupted write");
}
