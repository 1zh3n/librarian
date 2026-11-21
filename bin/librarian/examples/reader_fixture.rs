#[path = "../tests/fixtures/ai-materials/setup.rs"]
mod material_fixture;

#[path = "support/product.rs"]
mod fixture_product;

use std::{fs, io, path::Path, process::Command};

use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server_common::revision::sha256_hex;
use tower::ServiceExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::args().nth(1).unwrap_or("4176".into()).parse()?;
    let root = tempfile::tempdir()?;
    let release_targets = tempfile::tempdir()?;
    let users = UserStore::create_empty(root.path()).map_err(io::Error::other)?;
    users
        .create_user("reader", "reader-test-password", false, Profile::default())
        .map_err(io::Error::other)?;
    users
        .create_user(
            "offline-reader",
            "offline-reader-test-password",
            false,
            Profile::default(),
        )
        .map_err(io::Error::other)?;
    users
        .create_user(
            "fixture-admin",
            "fixture-admin-test-password",
            true,
            Profile::default(),
        )
        .map_err(io::Error::other)?;
    let deployment_token = users
        .create_token("fixture-admin", "test setup")
        .map_err(io::Error::other)?;
    let space = root.path().join("spaces/field");
    fs::create_dir_all(space.join("野外"))?;
    fs::create_dir_all(root.path().join("spaces/other"))?;
    fs::create_dir_all(root.path().join("spaces/release-backup"))?;
    fs::create_dir_all(root.path().join("spaces/zz-history"))?;
    fs::write(
        root.path().join("spaces.json"),
        json!({
            "field": {"name":"田野笔记","binding":{"prefix":"/field"},"access":"none",
                      "members":{"reader":{"role":"write"}},"revisions":"managed",
                      "revisionsCommit":{"quietSecs":5,"maxIntervalSecs":60}},
            "other": {"name":"另一空间","binding":{"prefix":"/other"},"access":"none",
                      "members":{"reader":{"role":"write"},"offline-reader":{"role":"read"}},"revisions":"managed",
                      "revisionsCommit":{"quietSecs":5,"maxIntervalSecs":60}},
            "zz-history": {"name":"版本归档用例","binding":{"prefix":"/zz-history"},"access":"none",
                      "members":{"reader":{"role":"write"}},"revisions":"managed",
                      "revisionsCommit":{"quietSecs":5,"maxIntervalSecs":60}},
            "release-backup": {"name":"浏览器本地备份","binding":{"prefix":"/release-backup"},
                      "access":"none","revisions":"managed"}
        })
        .to_string(),
    )?;
    fs::write(
        space.join("野外/01.md"),
        format!(
            "---\ntitle: 河岸清晨\n---\n\n## 湿地观察\n\n{}\n\n### 水线\n\n{}\n\n| 地点 | 记录 |\n| --- | --- |\n| 远处 | {} |\n\n```text\n{}\n```\n",
            "今天沿湿地木栈道记录水位。薄雾中看见几丛芦苇。".repeat(25),
            "水面在风起后有层层波纹。我们向北走到观鸟站。".repeat(25),
            "一段较长的表格文字".repeat(35),
            "一段较长的等宽文字".repeat(35),
        ),
    )?;
    fs::write(
        space.join("野外/02.md"),
        "---\ntitle: 林间回声\n---\n\n清晨听见鸟鸣。\n",
    )?;
    fs::write(space.join("野外/02.outline.md"), "自由提纲也写到了鸟鸣。\n")?;
    fs::write(
        root.path().join("spaces/other/01.md"),
        "# 另一份鸟鸣\n\n其他空间的记录。\n",
    )?;
    let metadata = root.path().join(".librarian");
    fs::create_dir(&metadata)?;
    fs::write(
        metadata.join("runner-token.sha256"),
        sha256_hex(b"reader-fixture-ai-token-only-for-tests"),
    )?;
    let managed_materials = std::env::args().nth(2).as_deref() == Some("--managed-materials");
    if managed_materials {
        fs::write(metadata.join("ai-test-loopback"), "127.0.0.1:9")?;
    }
    let app = fixture_product::open(root.path(), port)?;
    if managed_materials {
        material_fixture::configure(root.path())?;
    }
    configure_release_targets(
        root.path(),
        release_targets.path(),
        app.router(),
        &deployment_token,
    )
    .await?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    axum::serve(listener, app.router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn configure_release_targets(
    root: &Path,
    targets: &Path,
    router: Router,
    token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let response = router
        .oneshot(
            Request::get("/api/v1/workspaces")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    let workspaces: Vec<Value> =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await?)?;
    let field = workspaces
        .iter()
        .find(|value| value["name"] == "田野笔记")
        .ok_or("Missing fixture Workspace")?;
    let backup = workspaces
        .iter()
        .find(|value| value["name"] == "浏览器本地备份")
        .ok_or("Missing backup fixture Workspace")?;
    git(targets, &["init", "-q", "--bare", "backup.git"])?;
    git(targets, &["init", "-q", "--initial-branch=main", "site"])?;
    let site = targets.join("site");
    fs::create_dir_all(site.join("templates"))?;
    fs::write(
        site.join("zola.toml"),
        "base_url = 'https://blog.example.test'\n",
    )?;
    for template in ["article.html", "page.html"] {
        fs::write(
            site.join("templates").join(template),
            "{{ page.content | safe }}",
        )?;
    }
    fs::write(
        site.join("templates/section.html"),
        "{% for page in section.pages %}{{ page.title }}{% endfor %}",
    )?;
    git(&site, &["add", "--", "."])?;
    git(
        &site,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "Initial Zola site",
        ],
    )?;
    git(targets, &["clone", "-q", "--bare", "site", "blog.git"])?;
    let metadata = root.join(".librarian");
    fs::write(
        metadata.join("backup-targets.json"),
        json!({"targets":[{
            "id":"fixture-backup", "label":"本地备份", "workspaceId":backup["id"],
            "repository":targets.join("backup.git"), "branch":"workspace-backup"
        }]})
        .to_string(),
    )?;
    fs::write(metadata.join("publication-targets.json"), json!({"targets":[{
        "id":"fixture-zola", "label":"本地博客", "workspaceId":field["id"], "repository":targets.join("blog.git"),
        "branch":"main", "contentPath":"content/articles", "template":"article.html", "baseUrl":"https://blog.example.test"
    }]}).to_string())?;
    Ok(())
}

fn git(directory: &Path, arguments: &[&str]) -> io::Result<()> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }
}
