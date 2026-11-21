use std::{
    fs::{self, File},
    io::{self, Write},
    path::Path,
};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use tempfile::NamedTempFile;
use uuid::Uuid;

use super::db::Metadata;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    instance_id: Uuid,
    token: String,
}

fn read(path: &Path) -> io::Result<Identity> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 2048 {
        return Err(io::Error::other("Invalid runner identity file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(io::Error::other("Runner identity must have mode 0600"));
        }
    }
    let identity: Identity = serde_json::from_reader(File::open(path)?)
        .map_err(|_| io::Error::other("Invalid runner identity"))?;
    if identity.token.len() != 64 || !identity.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::other("Invalid runner identity"));
    }
    Ok(identity)
}

fn identity_file(path: &Path) -> io::Result<Identity> {
    match read(path) {
        Ok(identity) => return Ok(identity),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing identity directory"))?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let identity = Identity {
        instance_id: Uuid::new_v4(),
        token: sha256_hex(&random),
    };
    let mut stage = NamedTempFile::new_in(parent)?;
    serde_json::to_writer(stage.as_file_mut(), &identity)?;
    stage.write_all(b"\n")?;
    stage.as_file().sync_all()?;
    match stage.persist_noclobber(path) {
        Ok(_) => {
            File::open(parent)?.sync_all()?;
            Ok(identity)
        }
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => read(path),
        Err(e) => Err(e.error),
    }
}

/// Enroll a local managed runner, or verify the existing pairing on reinstall.
pub fn enroll(root: &Path, path: &Path) -> io::Result<()> {
    let metadata = Metadata::open(root).map_err(io::Error::other)?;
    let identity = identity_file(path)?;
    let id = identity.instance_id.to_string();
    let digest = sha256_hex(identity.token.as_bytes());
    let mut db = metadata
        .connection()
        .map_err(|_| io::Error::other("Runner registry unavailable"))?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(io::Error::other)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT token_digest FROM ai_runner_instances WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(io::Error::other)?;
    match existing {
        Some(expected) if expected != digest => {
            return Err(io::Error::other(
                "Runner identity does not match the enrolled instance",
            ))
        }
        Some(_) => (),
        None => {
            tx.execute(
                "INSERT INTO ai_runner_instances(id,token_digest,last_seen) VALUES(?1,?2,0)",
                params![id, digest],
            )
            .map_err(io::Error::other)?;
        }
    }
    tx.commit().map_err(io::Error::other)
}
