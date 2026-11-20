use std::{fs, io};

use serde_json::json;
use silverbullet_server::multi::users::{Profile, UserStore};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::args().nth(1).unwrap_or("4176".into()).parse()?;
    let root = tempfile::tempdir()?;
    let users = UserStore::create_empty(root.path()).map_err(io::Error::other)?;
    users
        .create_user("reader", "reader-test-password", false, Profile::default())
        .map_err(io::Error::other)?;
    let space = root.path().join("spaces/field");
    fs::create_dir_all(space.join("野外"))?;
    fs::create_dir_all(root.path().join("spaces/other"))?;
    fs::write(
        root.path().join("spaces.json"),
        json!({
            "field": {"name":"田野笔记","binding":{"prefix":"/field"},"access":"none",
                      "members":{"reader":{"role":"write"}},"revisions":"managed"},
            "other": {"name":"另一空间","binding":{"prefix":"/other"},"access":"none",
                      "members":{"reader":{"role":"write"}}}
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
    let app = librarian::Product::open(root.path(), port).map_err(io::Error::other)?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    axum::serve(listener, app.router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
