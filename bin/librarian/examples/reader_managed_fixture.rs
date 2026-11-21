//! An already configured, isolated installation for the managed Reader browser suite.
//! Enrollment, heartbeat, claims, tools, SSE and result writes use product entry points.
#[path = "support/product.rs"]
mod fixture_product;

use std::{error::Error, fs, io, net::Ipv4Addr, path::PathBuf};

use rusqlite::{params, Connection};
use serde_json::json;
use silverbullet_server::multi::users::{Profile, UserStore};
use silverbullet_server_common::crypto::encrypt_bound;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().ok_or("Missing temporary data root")?);
    let provider_port: u16 = args.next().ok_or("Missing HTTPS fixture port")?.parse()?;
    let users = UserStore::create_empty(&root).map_err(io::Error::other)?;
    users
        .create_user("reader", "reader-test-password", false, Profile::default())
        .map_err(io::Error::other)?;
    let space = root.join("spaces/field");
    fs::create_dir_all(&space)?;
    fs::write(
        root.join("spaces.json"),
        json!({
            "field":{"name":"田野笔记","binding":{"prefix":"/field"},"access":"none",
            "members":{"reader":{"role":"write"}},"revisions":"managed"}
        })
        .to_string(),
    )?;
    fs::write(
        space.join("甲样区.md"),
        "# 甲样区\n\n甲样区记录十二只白鹭。\n",
    )?;
    fs::write(
        space.join("乙样区.md"),
        "# 乙样区\n\n乙样区记录十九只白鹭。\n",
    )?;
    let dir = root.join(".librarian");
    fs::create_dir_all(&dir)?;
    let endpoint = format!("127.0.0.1:{provider_port}");
    fs::write(dir.join("ai-test-loopback"), &endpoint)?;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let addr = listener.local_addr()?;
    let product = fixture_product::open(&root, addr.port())?;

    let key = [32; 32];
    let keyfile = dir.join("ai-install.key");
    fs::write(&keyfile, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&keyfile, fs::Permissions::from_mode(0o600))?;
    }
    {
        let mut db = Connection::open(dir.join("metadata.sqlite3"))?;
        let tx = db.transaction()?;
        let now: i64 = tx.query_row("SELECT unixepoch()", [], |r| r.get(0))?;
        let models = ["field-observer", "field-compare"].map(|id| {
            json!({
                "id":id,"effort":{"supportedLevels":["low","high"],"defaultLevel":"low"}
            })
        });
        let catalog = json!({"fetchedAt":now,"models":models});
        let encrypted = encrypt_bound(&key, "provider-fixture-only", b"field")?;
        tx.execute(
            "INSERT INTO ai_connections(id,label,base_url,ciphertext,version,enabled,catalog)
          VALUES ('field','田野模型',?1,?2,1,1,?3)",
            params![
                format!("https://{endpoint}"),
                encrypted,
                catalog.to_string()
            ],
        )?;
        let choice = json!({"connectionId":"field","modelId":"field-observer","thinking":{"mode":"effort","level":"low"}});
        tx.execute("UPDATE ai_configuration SET enabled=1,mode='managed',default_choice=?1 WHERE singleton=1", [choice.to_string()])?;
        tx.commit()?;
    }
    println!("http://{addr}");
    axum::serve(listener, product.router()).await?;
    Ok(())
}
