use rusqlite::Connection;
use serde_json::Value;
use silverbullet_server_common::revision::sha256_hex;
use std::{fs, path::Path, process::Command};

#[test]
fn enrollment_is_private_idempotent_and_separate_for_each_runner() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path();
    let path = state.join(".librarian/first.json");
    let enroll = |file: &Path| {
        Command::new(env!("CARGO_BIN_EXE_librarian"))
            .arg("runner-enroll")
            .arg("--data-root")
            .arg(state)
            .arg("--identity-file")
            .arg(file)
            .output()
            .unwrap()
    };
    let created = enroll(&path);
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let bytes = fs::read(&path).unwrap();
    let identity: Value = serde_json::from_slice(&bytes).unwrap();
    let id = identity["instanceId"].as_str().unwrap();
    let token = identity["token"].as_str().unwrap();
    assert!(token.len() >= 48);
    assert!(!String::from_utf8_lossy(&created.stdout).contains(token));
    assert!(!String::from_utf8_lossy(&created.stderr).contains(token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(enroll(&path).status.success());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let db = Connection::open(state.join(".librarian/metadata.sqlite3")).unwrap();
    let digest: String = db
        .query_row(
            "SELECT token_digest FROM ai_runner_instances WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(digest, sha256_hex(token.as_bytes()));
    let second = state.join(".librarian/second.json");
    assert!(enroll(&second).status.success());
    let next: Value = serde_json::from_slice(&fs::read(second).unwrap()).unwrap();
    assert_ne!(next["instanceId"], identity["instanceId"]);
    assert_ne!(next["token"], identity["token"]);
    let altered = serde_json::json!({"instanceId":id,"token":next["token"]});
    fs::write(&path, altered.to_string()).unwrap();
    assert!(!enroll(&path).status.success());
    let current: String = db
        .query_row(
            "SELECT token_digest FROM ai_runner_instances WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, digest);
}
