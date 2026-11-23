use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

const PINNED: &[u8] = b"\x00first\r\n\xff";
const CURRENT: &[u8] = b"\x00current\r\n\x80";
const OPERATION: &str = "72a6f960-2014-4093-9be1-5de2bafc78dc";
const RETRY: &str = "fefad509-38ea-4266-a6b2-4047333fcaef";

struct Fixture {
    app: Option<librarian::Product>,
    root: TempDir,
    target: PathBuf,
    writer: String,
    administrator: String,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        let users = UserStore::create_empty(&data).unwrap();
        for account in ["writer", "administrator"] {
            users
                .create_user(
                    account,
                    "publication-test-password",
                    account == "administrator",
                    Profile::default(),
                )
                .unwrap();
        }
        let writer = users.create_token("writer", "publication editor").unwrap();
        let administrator = users
            .create_token("administrator", "publication administrator")
            .unwrap();

        let source = data.join("spaces/field");
        fs::create_dir_all(source.join("notes/media")).unwrap();
        fs::write(source.join("notes/Start.md"), concat!(
            "---\r\ntitle: \"Field notes\"\r\nstatus: published\r\ntags: [field, local]\r\npublished_at: 2026-11-19\r\n",
            "publication:\r\n  - target: blog\r\n    state: published\r\n    slug: start\r\n---\r\n",
            "Original article. See [the guide](Guide.md#details).\r\n\r\n",
            "![Figure](media/figure.png)\r\n"
        )).unwrap();
        fs::write(
            source.join("notes/Guide.md"),
            "---\ntitle: Guide\nstatus: published\n---\n## Details\n\nOriginal details.\n",
        )
        .unwrap();
        fs::write(source.join("notes/Duplicate.md"), "---\ntitle: Duplicate\npublication:\n  - target: blog\n    slug: start\n---\nDuplicate").unwrap();
        fs::write(
            source.join("notes/Missing.md"),
            "---\ntitle: Missing\n---\n[Missing file](media/missing.dat)\n",
        )
        .unwrap();
        fs::write(source.join("notes/media/figure.png"), PINNED).unwrap();
        fs::write(
            data.join("spaces.json"),
            json!({
                "field": {
                    "name":"Field","binding":{"prefix":"/field"},"access":"none",
                    "members":{"writer":{"role":"write"}},"revisions":"managed",
                    "revisionsCommit":{"quietSecs":300,"maxIntervalSecs":300}
                }
            })
            .to_string(),
        )
        .unwrap();

        let setup = root.path().join("target-setup");
        fs::create_dir(&setup).unwrap();
        git(&setup, &["init", "-q", "--initial-branch=main"]);
        fs::create_dir_all(setup.join("content/articles")).unwrap();
        fs::create_dir_all(setup.join("templates")).unwrap();
        fs::write(
            setup.join("zola.toml"),
            concat!(
                "base_url = 'https://example.test/docs'\n",
                "taxonomies = [{name = 'tags'}]\n"
            ),
        )
        .unwrap();
        fs::write(
            setup.join("templates/article.html"),
            "{{ page.content | safe }}",
        )
        .unwrap();
        fs::write(
            setup.join("templates/page.html"),
            "{{ page.content | safe }}",
        )
        .unwrap();
        for template in ["taxonomy_list.html", "taxonomy_single.html"] {
            fs::write(setup.join("templates").join(template), "Tags").unwrap();
        }
        fs::write(
            setup.join("templates/section.html"),
            "{% for page in section.pages %}{{ page.title }}{% endfor %}",
        )
        .unwrap();
        fs::write(
            setup.join("content/articles/Existing.md"),
            "+++\ntitle = 'Other owner'\n+++\nOther site content.\n",
        )
        .unwrap();
        fs::write(setup.join("KEEP.txt"), b"unrelated\r\n\xff").unwrap();
        git(&setup, &["add", "--", "."]);
        git(
            &setup,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "Initial target",
            ],
        );
        let target = root.path().join("target.git");
        git(
            root.path(),
            &["clone", "-q", "--bare", "target-setup", "target.git"],
        );
        let app = librarian::Product::open(&data, 0).unwrap();
        app.manager()
            .instance("field")
            .unwrap()
            .revisions
            .as_ref()
            .unwrap()
            .snapshot_now()
            .unwrap();
        Self {
            app: Some(app),
            root,
            target,
            writer,
            administrator,
        }
    }

    fn source(&self) -> PathBuf {
        self.root.path().join("data/spaces/field")
    }

    fn restart(&mut self) {
        drop(self.app.take());
        self.app = Some(librarian::Product::open(&self.root.path().join("data"), 0).unwrap());
    }

    fn edit_target(&self, path: &str, contents: &[u8]) -> String {
        let editor = tempfile::tempdir_in(self.root.path()).unwrap();
        git(
            editor.path(),
            &[
                "clone",
                "-q",
                "--branch",
                "main",
                self.target.to_str().unwrap(),
                ".",
            ],
        );
        fs::write(editor.path().join(path), contents).unwrap();
        git(editor.path(), &["add", "--", path]);
        git(
            editor.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "Edit target independently",
            ],
        );
        git(editor.path(), &["push", "-q", "origin", "main"]);
        text_git(&self.target, &["rev-parse", "main"])
    }

    fn configure(&self, workspace: &str) {
        fs::write(self.root.path().join("data/.librarian/publication-targets.json"), json!({
            "targets":[{
                "id":"blog","label":"Local Zola blog","workspaceId":workspace,"repository":self.target,
                "branch":"main","contentPath":"content/articles","template":"article.html",
                "baseUrl":"https://example.test/docs"
            }]
        }).to_string()).unwrap();
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        token: &str,
        request: Value,
    ) -> (StatusCode, Value) {
        let response = self
            .app
            .as_ref()
            .unwrap()
            .router()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 2_000_000).await.unwrap();
        (parts.status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn scope(&self) -> (String, Value, String) {
        let (status, workspaces) = self
            .request("GET", "/workspaces", &self.administrator, Value::Null)
            .await;
        assert_eq!(status, StatusCode::OK, "{workspaces}");
        let workspace = workspaces[0]["id"].as_str().unwrap().to_owned();
        let (status, docs) = self
            .request(
                "GET",
                &format!("/workspaces/{workspace}/documents"),
                &self.administrator,
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{docs}");
        self.configure(&workspace);
        set_level(&self.root.path().join("data"), "public");
        (
            workspace,
            docs,
            text_git(&self.source(), &["rev-parse", "HEAD"]),
        )
    }
}

fn git(directory: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
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

fn text_git(directory: &Path, args: &[&str]) -> String {
    String::from_utf8(git(directory, args))
        .unwrap()
        .trim()
        .to_owned()
}

fn doc(docs: &Value, path: &str) -> String {
    docs.as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == path)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn set_level(data: &Path, level: &str) {
    let db = rusqlite::Connection::open(data.join(".librarian/metadata.sqlite3")).unwrap();
    db.execute(
        "UPDATE workspaces SET security_level = ?1 WHERE space_id = 'field'",
        [level],
    )
    .unwrap();
}

fn confirmation(
    workspace: &str,
    commit: &str,
    documents: &[String],
    operation: &str,
    confirm: bool,
) -> Value {
    json!({"workspaceId":workspace,"targetId":"blog","commitId":commit,"documentIds":documents,"operationId":operation,"confirm":confirm})
}

fn zola_available() -> bool {
    let available = std::env::var_os("LIBRARIAN_ZOLA").is_some()
        || Command::new("zola")
            .arg("--version")
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).trim() == "zola 0.23.6"
            });
    if !available {
        eprintln!("Set LIBRARIAN_ZOLA to Zola 0.23.6 to run the real build fixture");
    }
    available
}

#[tokio::test]
async fn publishes_pinned_revision_and_exact_assets_once_after_confirmation() {
    if !zola_available() {
        return;
    }
    let mut f = Fixture::new();
    let (workspace, docs, commit) = f.scope().await;
    let selected = [doc(&docs, "notes/Start.md"), doc(&docs, "notes/Guide.md")];
    let target_head = text_git(&f.target, &["rev-parse", "refs/heads/main"]);
    let (status, targets) = f
        .request(
            "GET",
            &format!("/publications/targets?workspaceId={workspace}"),
            &f.administrator,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{targets}");
    assert_eq!(
        targets,
        json!({"targets":[{"id":"blog","label":"Local Zola blog"}]})
    );
    let (status, proposal) = f
        .request(
            "POST",
            "/publications",
            &f.writer,
            confirmation(&workspace, &commit, &selected, OPERATION, false),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");
    assert_eq!(proposal["status"], "pending");
    assert_eq!(proposal["documentIds"], json!(selected));
    let (status, listing) = f
        .request(
            "GET",
            &format!("/publications?workspaceId={workspace}"),
            &f.administrator,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{listing}");
    assert_eq!(listing["publications"], json!([proposal]));
    assert_eq!(
        text_git(&f.target, &["rev-parse", "refs/heads/main"]),
        target_head
    );
    let endpoint = format!("/publications/{}", proposal["id"].as_str().unwrap());
    let (status, _) = f
        .request(
            "POST",
            &format!("{endpoint}/confirm"),
            &f.writer,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    fs::write(f.source().join("notes/media/figure.png"), CURRENT).unwrap();
    fs::write(f.source().join("notes/Start.md"), "Uncommitted rewrite\n").unwrap();
    let (status, published) = f
        .request(
            "POST",
            &format!("{endpoint}/confirm"),
            &f.administrator,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["status"], "published", "{published}");
    assert_eq!(published["sourceCommitId"], commit);
    assert_eq!(
        published["url"],
        "https://example.test/docs/articles/start/"
    );
    let head = text_git(&f.target, &["rev-parse", "refs/heads/main"]);
    assert_eq!(published["publishedCommitId"], head);
    assert_eq!(
        text_git(&f.target, &["rev-list", "--count", "refs/heads/main"]),
        "2"
    );
    let page = text_git(&f.target, &["show", "main:content/articles/start/index.md"]);
    assert!(page.starts_with("+++\n"));
    assert!(page.contains("title = \"Field notes\""));
    assert!(page.contains("template = \"article.html\""));
    assert!(page.contains("date = 2026-11-19"));
    assert!(page.contains("tags = ["));
    assert!(page.contains("Original article."));
    assert!(page.contains("@/articles/guide/index.md#details"));
    assert!(page.contains("![Figure](assets/media/figure.png)"));
    assert_eq!(
        git(
            &f.target,
            &[
                "show",
                "main:content/articles/start/assets/media/figure.png"
            ]
        ),
        PINNED
    );
    assert_eq!(
        git(&f.target, &["show", "main:KEEP.txt"]),
        b"unrelated\r\n\xff"
    );
    assert!(
        text_git(&f.target, &["show", "main:content/articles/Existing.md"])
            .contains("Other site content.")
    );
    assert_eq!(
        fs::read(f.source().join("notes/media/figure.png")).unwrap(),
        CURRENT
    );
    assert_eq!(
        fs::read_to_string(f.source().join("notes/Start.md")).unwrap(),
        "Uncommitted rewrite\n"
    );

    let rendered_site = tempfile::tempdir_in(f.root.path()).unwrap();
    git(
        rendered_site.path(),
        &["clone", "-q", f.target.to_str().unwrap(), "."],
    );
    let zola = std::env::var_os("LIBRARIAN_ZOLA").unwrap_or_else(|| "zola".into());
    let rendered = Command::new(zola)
        .arg("build")
        .current_dir(rendered_site.path())
        .output()
        .unwrap();
    assert!(
        rendered.status.success(),
        "{}",
        String::from_utf8_lossy(&rendered.stderr)
    );
    let public = rendered_site.path().join("public/articles/start");
    let html = fs::read_to_string(public.join("index.html")).unwrap();
    assert!(html.contains("https://example.test/docs/articles/guide/#details"));
    assert!(html.contains("https://example.test/docs/articles/start/assets/media/figure.png"));
    assert_eq!(
        fs::read(public.join("assets/media/figure.png")).unwrap(),
        PINNED
    );

    f.restart();
    let (status, replay) = f
        .request("GET", &endpoint, &f.administrator, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay, published);
    let (status, reissued) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &selected, OPERATION, true),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{reissued}");
    assert_eq!(reissued, published);
    let (_, same_source) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &selected, RETRY, true),
        )
        .await;
    assert_eq!(same_source["publishedCommitId"], head, "{same_source}");
    assert_eq!(
        text_git(&f.target, &["rev-list", "--count", "refs/heads/main"]),
        "2"
    );
}

#[tokio::test]
async fn invalid_slug_selection_or_missing_asset_leaves_target_ref_unchanged() {
    let f = Fixture::new();
    let (workspace, docs, commit) = f.scope().await;
    let head = text_git(&f.target, &["rev-parse", "refs/heads/main"]);
    // Both selected IDs have moved; Start's current path was occupied by Missing.
    for (operation, from, to) in [
        (
            "fac10872-c65c-41c9-ade4-06cb0f9db4dc",
            "notes/Missing.md",
            "notes/Renamed.md",
        ),
        (
            "399fa35c-102c-43a2-b06d-f00fd32571ce",
            "notes/Start.md",
            "notes/Missing.md",
        ),
    ] {
        let (status, moved) = f
            .request(
                "POST",
                &format!("/workspaces/{workspace}/rename"),
                &f.administrator,
                json!({"operationId":operation,"from":from,"to":to}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{moved}");
    }
    for (operation, files, message) in [
        (
            OPERATION,
            vec!["notes/Start.md", "notes/Duplicate.md"],
            "slug",
        ),
        (RETRY, vec!["notes/Missing.md"], "asset"),
    ] {
        let selected: Vec<_> = files.iter().map(|file| doc(&docs, file)).collect();
        let (status, failure) = f
            .request(
                "POST",
                "/publications",
                &f.administrator,
                confirmation(&workspace, &commit, &selected, operation, true),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{failure}");
        assert_eq!(failure["status"], "failed", "{failure}");
        assert!(
            failure["message"].as_str().unwrap().contains(message),
            "{failure}"
        );
        assert_eq!(text_git(&f.target, &["rev-parse", "refs/heads/main"]), head);
        assert_eq!(
            git(&f.target, &["show", "main:KEEP.txt"]),
            b"unrelated\r\n\xff"
        );
    }
}

#[tokio::test]
async fn build_failure_is_retryable_and_republication_changes_only_its_owned_files() {
    if !zola_available() {
        return;
    }
    let f = Fixture::new();
    let (workspace, docs, commit) = f.scope().await;
    let all = [doc(&docs, "notes/Start.md"), doc(&docs, "notes/Guide.md")];
    let guide_only = [doc(&docs, "notes/Guide.md")];

    let broken = f.edit_target("templates/article.html", b"{{ invalid syntax ??? }}");
    let request = confirmation(&workspace, &commit, &all, OPERATION, true);
    let (status, failure) = f
        .request("POST", "/publications", &f.administrator, request.clone())
        .await;
    assert_eq!(status, StatusCode::CREATED, "{failure}");
    assert_eq!(failure["status"], "failed", "{failure}");
    assert!(failure["message"]
        .as_str()
        .unwrap()
        .contains("Zola build failed"));
    assert_eq!(text_git(&f.target, &["rev-parse", "main"]), broken);

    f.edit_target(
        "templates/article.html",
        b"<article>{{ page.content | safe }}</article>",
    );
    let (status, published) = f
        .request("POST", "/publications", &f.administrator, request)
        .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["status"], "published", "{published}");

    let (status, replacement) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &guide_only, RETRY, true),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{replacement}");
    assert_eq!(replacement["status"], "published", "{replacement}");
    assert_eq!(
        replacement["url"],
        "https://example.test/docs/articles/guide/"
    );
    assert!(git(
        &f.target,
        &["ls-tree", "main", "--", "content/articles/start"]
    )
    .is_empty());
    assert_eq!(
        git(&f.target, &["show", "main:KEEP.txt"]),
        b"unrelated\r\n\xff"
    );

    let changed = f.edit_target(
        "content/articles/guide/index.md",
        b"+++\ntitle = 'Manually maintained'\n+++\nDifferent owner edit\n",
    );
    let (status, conflict) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(
                &workspace,
                &commit,
                &guide_only,
                "0fa1fbfb-72ab-4b69-88a7-652ef671aa5c",
                true,
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{conflict}");
    assert_eq!(conflict["status"], "failed", "{conflict}");
    assert!(
        conflict["message"].as_str().unwrap().contains("modified"),
        "{conflict}"
    );
    assert_eq!(text_git(&f.target, &["rev-parse", "main"]), changed);
    assert!(
        text_git(&f.target, &["show", "main:content/articles/guide/index.md"])
            .contains("Different owner edit")
    );
}

#[tokio::test]
async fn publication_requires_a_public_workspace() {
    let f = Fixture::new();
    let (workspace, docs, commit) = f.scope().await;
    set_level(&f.root.path().join("data"), "internal");
    let selected = [doc(&docs, "notes/Start.md")];
    let (status, proposal) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &selected, OPERATION, false),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");

    let (status, error) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &selected, OPERATION, true),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "policy_blocked");
    assert_eq!(error["ruleId"], "publication_requires_public_workspace");
}

#[tokio::test]
async fn publication_blocks_high_confidence_credentials() {
    let f = Fixture::new();
    let (workspace, docs, _) = f.scope().await;
    let source = f.source();
    let start = source.join("notes/Start.md");
    let mut text = fs::read_to_string(&start).unwrap();
    text.push_str("\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n");
    fs::write(&start, text).unwrap();
    git(&source, &["add", "--", "notes/Start.md"]);
    git(
        &source,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "add secret",
        ],
    );
    let commit = text_git(&source, &["rev-parse", "HEAD"]);
    let selected = [doc(&docs, "notes/Start.md")];
    let (status, proposal) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &selected, OPERATION, false),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");

    let (status, error) = f
        .request(
            "POST",
            "/publications",
            &f.administrator,
            confirmation(&workspace, &commit, &selected, OPERATION, true),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(error["code"], "policy_blocked");
    assert_eq!(error["ruleId"], "private_key");
}
