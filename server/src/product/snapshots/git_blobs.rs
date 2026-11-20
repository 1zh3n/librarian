use std::path::Path;

use crate::revisions::{git, RevisionStore};

use super::{ApiError, StatusCode};

const ENV: [(&str, &str); 3] = [
    ("GIT_NO_REPLACE_OBJECTS", "1"),
    ("GIT_ALLOW_PROTOCOL", ""),
    ("SB_GIT_NO_HOOKS", "1"),
];

pub(in crate::product) fn resolve_commit(repo: &Path, commit: &str) -> Result<String, ApiError> {
    git::run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{commit}^{{commit}}"),
        ],
        &ENV,
    )
    .map(|object| object.trim().to_owned())
    .map_err(|_| ApiError::not_found())
}

pub(in crate::product) fn find(
    store: &RevisionStore,
    repo: &Path,
    commit: &str,
    path: &str,
    limit: usize,
) -> Result<Option<String>, ApiError> {
    let relative = store.rel(path);
    let output = git::run_bytes(
        repo,
        &[
            "ls-tree",
            "-zl",
            "--full-tree",
            commit,
            "--",
            &format!(":(literal){relative}"),
        ],
        &ENV,
    )
    .map_err(ApiError::internal)?;
    if output.is_empty() {
        return Ok(None);
    }
    let output = std::str::from_utf8(&output).map_err(ApiError::internal)?;
    let Some((metadata, name)) = output
        .strip_suffix('\0')
        .and_then(|line| line.split_once('\t'))
    else {
        return Err(ApiError::not_found());
    };
    let mut metadata = metadata.split_ascii_whitespace();
    if name != relative
        || !matches!(metadata.next(), Some("100644" | "100755"))
        || metadata.next() != Some("blob")
    {
        return Err(ApiError::not_found());
    }
    let object = metadata.next().ok_or_else(ApiError::not_found)?;
    let size: usize = metadata
        .next()
        .ok_or_else(ApiError::not_found)?
        .parse()
        .map_err(ApiError::internal)?;
    if size > limit {
        return Err(super::too_large());
    }
    Ok(Some(object.to_owned()))
}

pub(in crate::product) fn read(repo: &Path, object: &str) -> Result<Vec<u8>, ApiError> {
    git::run_bytes(repo, &["cat-file", "blob", object], &ENV).map_err(ApiError::internal)
}

pub(in crate::product) fn repo(
    state: &crate::state::ServerState,
) -> Result<(&RevisionStore, std::path::PathBuf), ApiError> {
    state
        .revisions
        .as_ref()
        .map(|engine| engine.store())
        .and_then(|store| store.repo_root().map(|root| (store, root)))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "revisions_disabled",
                "Version history is unavailable for this workspace",
            )
        })
}

pub(super) fn pin(repo: &Path, key: &str, commit: &str) -> Result<(), ApiError> {
    // The link credential itself never leaves the HTTP response.
    git::run(
        repo,
        &[
            "update-ref",
            "--no-deref",
            &reference(key),
            commit,
            &"0".repeat(commit.len()),
        ],
        &ENV,
    )
    .map(drop)
    .map_err(ApiError::internal)
}

pub(super) fn unpin(repo: &Path, key: &str) -> Result<(), ApiError> {
    git::run(
        repo,
        &["update-ref", "--no-deref", "-d", &reference(key)],
        &ENV,
    )
    .map(drop)
    .map_err(ApiError::internal)
}

fn reference(key: &str) -> String {
    format!("refs/librarian/snapshots/{key}")
}
