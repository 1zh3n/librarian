//! Synthetic managed installation for the material tool and Reader tests.
//! The test runner calls only Librarian. No provider request is made.
use std::{error::Error, fs, path::Path};

use rusqlite::{params, Connection};
use serde_json::json;
use silverbullet_server_common::{crypto::encrypt_bound, revision::sha256_hex};

pub const RUNNER: &str = "synthetic-material-fixture-token";
pub const INSTANCE: &str = "material-fixture";

pub fn configure(root: &Path) -> Result<(), Box<dyn Error>> {
    let dir = root.join(".librarian");
    let key = [18; 32];
    let keyfile = dir.join("ai-install.key");
    fs::write(&keyfile, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(keyfile, fs::Permissions::from_mode(0o600))?;
    }
    let model = "material-test";
    let choice =
        json!({"connectionId":"local","modelId":model,"thinking":{"mode":"provider_default"}});
    let mut conn = Connection::open(dir.join("metadata.sqlite3"))?;
    let tx = conn.transaction()?;
    let now: i64 = tx.query_row("SELECT unixepoch()", [], |r| r.get(0))?;
    let catalog = json!({"fetchedAt":now,"models":[{"id":model,"name":"Synthetic material reader","maxOutputTokens":1024}]});
    let ciphertext = encrypt_bound(&key, "fixture-only", b"local")?;
    tx.execute("INSERT INTO ai_connections(id,label,base_url,ciphertext,version,enabled,catalog) VALUES ('local','Fixture','http://127.0.0.1:9',?1,1,1,?2)",params![ciphertext,catalog.to_string()])?;
    tx.execute(
        "UPDATE ai_configuration SET enabled=1, mode='managed', default_choice=? WHERE singleton=1",
        [choice.to_string()],
    )?;
    tx.execute(
        "INSERT INTO ai_runner_instances(id,token_digest,last_seen) VALUES (?1,?2,unixepoch())",
        params![INSTANCE, sha256_hex(RUNNER.as_bytes())],
    )?;
    tx.commit()?;
    Ok(())
}
