use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use rusqlite::Connection;

use crate::state::ServerState;

use super::{contract::ApiError, db::Metadata};

pub(super) const WORKSPACE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub(super) const WORKSPACE_COUNT: i64 = 10;
const AI_WORKSPACE_CONCURRENCY: i64 = 2;
const AI_GLOBAL_CONCURRENCY: i64 = 8;
const CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_ENTRIES: usize = 200_000;
const MAX_DEPTH: usize = 64;

struct Cached {
    bytes: u64,
    measured: Instant,
}

static USAGE: LazyLock<Mutex<HashMap<String, Cached>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn check_workspace_count(metadata: &Metadata, owner: &str) -> Result<(), ApiError> {
    let count: i64 = metadata.connection()?.query_row(
        "SELECT COUNT(*) FROM workspaces
         WHERE owner = ?1 AND origin = 'native' AND retired = 0",
        [owner],
        |row| row.get(0),
    )?;
    if count >= WORKSPACE_COUNT {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "workspace_quota_exceeded",
            "The account has reached its workspace limit",
        ));
    }
    Ok(())
}

/// Charges a mutation against the workspace size limit. The first call for a
/// folder measures it; later calls update the cache and periodically remeasure.
pub(super) fn check_and_charge(state: &ServerState, delta: i64) -> Result<(), ApiError> {
    charge(
        &state.space_folder_path,
        Path::new(&state.space_folder_path),
        delta,
        WORKSPACE_BYTES,
    )
}

fn charge(key: &str, root: &Path, delta: i64, limit: u64) -> Result<(), ApiError> {
    if delta == 0 {
        return Ok(());
    }
    let mut usage = USAGE.lock().map_err(ApiError::internal)?;
    let entry = usage.entry(key.to_owned()).or_insert_with(|| Cached {
        bytes: 0,
        measured: Instant::now() - CACHE_TTL,
    });
    if entry.measured.elapsed() >= CACHE_TTL {
        entry.bytes = measure(root)?;
        entry.measured = Instant::now();
    }
    let next = if delta > 0 {
        entry.bytes.saturating_add(delta as u64)
    } else {
        entry.bytes.saturating_sub(delta.unsigned_abs())
    };
    if next > limit {
        return Err(ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "workspace_quota_exceeded",
            "The workspace has reached its storage limit",
        ));
    }
    entry.bytes = next;
    Ok(())
}

pub(super) fn check_ai_concurrency_in(
    connection: &Connection,
    workspace: &str,
) -> Result<(), ApiError> {
    let now = chrono::Utc::now().timestamp();
    let global: i64 = connection.query_row(
        "SELECT COUNT(*) FROM ai_operations
         WHERE status = 'running' AND (expires_at IS NULL OR expires_at > ?1)",
        [now],
        |row| row.get(0),
    )?;
    if global >= AI_GLOBAL_CONCURRENCY {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "ai_busy",
            "The AI queue is full; retry later",
        ));
    }
    let scoped: i64 = connection.query_row(
        "SELECT COUNT(*) FROM ai_operations
         WHERE workspace_id = ?1 AND status = 'running'
           AND (expires_at IS NULL OR expires_at > ?2)",
        rusqlite::params![workspace, now],
        |row| row.get(0),
    )?;
    if scoped >= AI_WORKSPACE_CONCURRENCY {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "ai_busy",
            "The workspace AI queue is full; retry later",
        ));
    }
    Ok(())
}

fn measure(root: &Path) -> Result<u64, ApiError> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut bytes = 0u64;
    let mut entries = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return Err(unavailable());
        }
        let reader = match std::fs::read_dir(&directory) {
            Ok(reader) => reader,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(ApiError::internal(error)),
        };
        for entry in reader {
            let entry = entry.map_err(ApiError::internal)?;
            entries = entries.saturating_add(1);
            if entries > MAX_ENTRIES {
                return Err(unavailable());
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = entry.file_type().map_err(ApiError::internal)?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if matches!(name.as_ref(), ".git" | ".librarian") {
                    continue;
                }
                stack.push((entry.path(), depth + 1));
            } else if file_type.is_file() {
                let metadata = entry.metadata().map_err(ApiError::internal)?;
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(bytes)
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "usage_unavailable",
        "Workspace usage could not be measured",
    )
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{charge, measure};
    use tempfile::tempdir;

    #[test]
    fn measure_counts_files_and_ignores_git_metadata() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::create_dir_all(dir.path().join(".git/objects")).unwrap();
        fs::create_dir_all(dir.path().join(".librarian")).unwrap();
        fs::write(dir.path().join("notes/a.md"), b"hello").unwrap();
        fs::write(dir.path().join(".git/objects/blob"), vec![0u8; 4096]).unwrap();
        fs::write(dir.path().join(".librarian/db"), vec![0u8; 4096]).unwrap();
        assert_eq!(measure(dir.path()).unwrap(), 5);
    }

    #[test]
    fn quota_rejects_a_charge_past_the_limit() {
        let dir = tempdir().unwrap();
        assert!(charge("test", dir.path(), 6, 5).is_err());
        assert!(charge("test", dir.path(), 5, 5).is_ok());
        assert!(charge("test", dir.path(), -5, 5).is_ok());
        assert!(charge("test", dir.path(), 0, 5).is_ok());
    }
}
