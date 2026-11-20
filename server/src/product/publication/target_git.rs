use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use silverbullet_server_common::revision::sha256_hex;

use crate::revisions::git;

use super::{config::Target, render::Output};

const GIT_LOCAL: [(&str, &str); 5] = [
    ("GIT_ALLOW_PROTOCOL", "file"),
    ("GIT_NO_REPLACE_OBJECTS", "1"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    (
        "GIT_CONFIG_GLOBAL",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    ),
    ("SB_GIT_NO_HOOKS", "1"),
];

const FILE_LIMIT: usize = 64 * 1024 * 1024;
const MANIFEST_LIMIT: usize = 256 * 1024;
const BUILD_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ownership {
    workspace_id: String,
    target_id: String,
    files: BTreeMap<String, String>,
}

pub(super) fn pin_source(repo: &Path, operation: &str, commit: &str) -> Result<(), String> {
    let reference = format!("refs/librarian/publications/{operation}");
    if local(repo, &["rev-parse", "--verify", &reference]).is_ok_and(|existing| existing == commit)
    {
        return Ok(());
    }
    local(
        repo,
        &[
            "update-ref",
            "--no-deref",
            &reference,
            commit,
            &"0".repeat(commit.len()),
        ],
    )?;
    Ok(())
}

pub(super) fn contains(target: &Target, commit: &str) -> Result<bool, String> {
    let tip = head(target)?;
    if commit == tip {
        return Ok(true);
    }
    if local(&target.repository, &["cat-file", "-t", commit]).is_err() {
        return Ok(false);
    }
    match local(
        &target.repository,
        &["merge-base", "--is-ancestor", commit, &tip],
    ) {
        Ok(_) => Ok(true),
        Err(message) if message.is_empty() => Ok(false),
        Err(_) => Err("Could not verify publication commit in target history".into()),
    }
}

pub(super) fn publish(
    target: &Target,
    mut output: Output,
    prepare: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    let parent = head(target)?;
    let reference = target.reference();
    let work = tempfile::tempdir().map_err(|_| "Could not create the Zola build workspace")?;
    let repository = target
        .repository
        .to_str()
        .ok_or("Invalid publication repository path")?;
    let checkout = work.path().join("site");
    fs::create_dir(&checkout).map_err(|_| "Could not create the target checkout")?;
    local(&checkout, &["init", "-q"]).map_err(|_| "Could not initialize the target checkout")?;
    local(
        &checkout,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            repository,
            &reference,
        ],
    )
    .map_err(|_| "Could not read the configured local Git target")?;
    let fetched = local(&checkout, &["rev-parse", "FETCH_HEAD"])
        .map_err(|_| "Could not verify target checkout")?;
    if fetched != parent {
        return Err("Publication target changed during checkout; retry confirmation".into());
    }
    local(&checkout, &["checkout", "--detach", "--quiet", &parent])
        .map_err(|_| "Could not check out the local Zola target")?;

    let manifest_path = target.manifest_file();
    let previous =
        if let Some(bytes) = git_file(&checkout, &parent, &manifest_path, MANIFEST_LIMIT)? {
            let parsed = serde_json::from_slice::<Ownership>(&bytes)
                .map_err(|_| "Invalid previous Librarian publication manifest")?;
            if parsed.workspace_id != output.workspace || parsed.target_id != target.id {
                return Err("Publication target files are owned by another workspace".into());
            }
            parsed.files
        } else {
            BTreeMap::new()
        };
    for (path, digest) in &previous {
        if !target.new_file_allowed(path) {
            return Err("Previous publication manifest contains an out-of-scope path".into());
        }
        let existing = git_file(&checkout, &parent, path, FILE_LIMIT)?;
        if existing.is_none_or(|bytes| sha256_hex(&bytes) != *digest) {
            return Err(format!(
                "A previously generated file has been modified: {path}"
            ));
        }
    }
    let section = target.section_file();
    if !previous.contains_key(&section)
        && git_file(&checkout, &parent, &section, FILE_LIMIT)?.is_some()
    {
        // The target may already have its own section settings.
        output.files.remove(&section);
    }
    let mut seen = BTreeSet::new();
    for path in output.files.keys() {
        if !target.new_file_allowed(path) || !seen.insert(path.to_ascii_lowercase()) {
            return Err(format!("Conflicting generated path: {path}"));
        }
        if !previous.contains_key(path) && git_file(&checkout, &parent, path, FILE_LIMIT)?.is_some()
        {
            return Err(format!(
                "Publication would overwrite an independent target file: {path}"
            ));
        }
    }

    for path in previous
        .keys()
        .filter(|path| !output.files.contains_key(*path))
    {
        let disk_path = checked_path(&checkout, path)?;
        fs::remove_file(&disk_path).map_err(|_| "Could not remove a stale generated file")?;
        local(&checkout, &["update-index", "--force-remove", "--", path])
            .map_err(|_| "Could not stage removal of a stale generated file")?;
    }
    let ownership = Ownership {
        workspace_id: output.workspace,
        target_id: target.id.clone(),
        files: output
            .files
            .iter()
            .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
            .collect(),
    };
    let manifest = serde_json::to_vec_pretty(&ownership)
        .map_err(|_| "Could not serialize publication manifest")?;
    if manifest.len() > MANIFEST_LIMIT {
        return Err("Publication has too many generated paths".into());
    }
    output.files.insert(manifest_path, manifest);
    for (path, contents) in output.files {
        let destination = checked_path(&checkout, &path)?;
        fs::create_dir_all(destination.parent().ok_or("Invalid generated file path")?)
            .and_then(|()| fs::write(&destination, contents))
            .map_err(|_| format!("Could not write generated output: {path}"))?;
        let oid = local(
            &checkout,
            &["hash-object", "-w", "--no-filters", "--", &path],
        )
        .map_err(|_| "Could not store generated Git bytes")?;
        local(
            &checkout,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                "100644",
                &oid,
                &path,
            ],
        )
        .map_err(|_| "Could not stage generated Git files")?;
    }

    build(&checkout, &work.path().join("public"), &target.base_url)?;
    let changed = local(&checkout, &["write-tree"])
        .map_err(|_| "Could not verify generated Git tree")?
        != local(&checkout, &["rev-parse", "HEAD^{tree}"])
            .map_err(|_| "Could not verify target Git tree")?;
    if !changed {
        prepare(&parent)?;
        if head(target)? != parent {
            return Err("Publication target changed after building; retry confirmation".into());
        }
        return Ok(parent);
    }

    local(
        &checkout,
        &[
            "-c",
            "user.name=Librarian",
            "-c",
            "user.email=librarian@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Publish Librarian documents",
        ],
    )
    .map_err(|_| "Could not create the publication commit")?;
    let commit = local(&checkout, &["rev-parse", "HEAD"])
        .map_err(|_| "Could not verify publication commit")?;
    prepare(&commit)?;
    local(
        &checkout,
        &[
            "push",
            &format!("--force-with-lease={reference}:{parent}"),
            "--",
            repository,
            &format!("{commit}:{reference}"),
        ],
    )
    .map_err(|_| "Publication target changed or could not be updated; retry confirmation")?;
    Ok(commit)
}

fn head(target: &Target) -> Result<String, String> {
    if !local(&target.repository, &["rev-parse", "--is-bare-repository"])
        .is_ok_and(|result| result == "true")
    {
        return Err("Publication target must be a local bare Git repository".into());
    }
    local(
        &target.repository,
        &["show-ref", "--verify", "--hash", &target.reference()],
    )
    .map_err(|_| "The configured target branch must already exist".into())
}

fn local(repo: &Path, args: &[&str]) -> Result<String, String> {
    git::run(repo, args, &GIT_LOCAL).map(|text| text.trim().to_owned())
}

fn git_file(
    repo: &Path,
    commit: &str,
    path: &str,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let tree = git::run_bytes(
        repo,
        &[
            "ls-tree",
            "-zl",
            "--full-tree",
            commit,
            "--",
            &format!(":(literal){path}"),
        ],
        &GIT_LOCAL,
    )
    .map_err(|_| "Could not read the target Git tree")?;
    if tree.is_empty() {
        return Ok(None);
    }
    let tree = std::str::from_utf8(&tree).map_err(|_| "Invalid target path")?;
    let (entry, actual) = tree
        .strip_suffix('\0')
        .and_then(|line| line.split_once('\t'))
        .ok_or("Invalid target path")?;
    let mut parts = entry.split_ascii_whitespace();
    if actual != path
        || !matches!(parts.next(), Some("100644" | "100755"))
        || parts.next() != Some("blob")
    {
        return Err(format!(
            "Target path is already occupied by a special file: {path}"
        ));
    }
    let object = parts.next().ok_or("Invalid target blob")?;
    let length = parts
        .next()
        .and_then(|bytes| bytes.parse::<usize>().ok())
        .ok_or("Invalid target blob size")?;
    if length > limit {
        return Err("Target file exceeds size limit".into());
    }
    git::run_bytes(repo, &["cat-file", "blob", object], &GIT_LOCAL)
        .map(Some)
        .map_err(|_| "Could not read target file".into())
}

fn checked_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut destination = root.to_owned();
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        destination.push(component);
        match fs::symlink_metadata(&destination) {
            Ok(details)
                if if components.peek().is_some() {
                    !details.is_dir()
                } else {
                    !details.is_file()
                } =>
            {
                return Err(format!(
                    "Target path is occupied by an independent entry: {path}"
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(format!("Could not access generated target path: {path}")),
        }
    }
    Ok(destination)
}

fn build(site: &Path, public: &Path, base_url: &str) -> Result<(), String> {
    let executable = std::env::var_os("LIBRARIAN_ZOLA").unwrap_or_else(|| "zola".into());
    let command = || {
        let mut command = Command::new(&executable);
        command.current_dir(site).env_clear();
        for key in ["PATH", "SystemRoot"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
    };
    let mut version = command();
    version.arg("--version");
    let (success, version) = run_zola(version)?;
    if !success || version.trim() != "zola 0.23.6" {
        return Err("Publication requires Zola 0.23.6".into());
    }
    let mut build = command();
    build
        .args(["build", "--base-url", base_url, "--output-dir"])
        .arg(public);
    let (success, details) = run_zola(build)?;
    if success {
        Ok(())
    } else {
        tracing::warn!(output = %details, "Zola publication build failed");
        Err("Zola build failed; review the configured site and selected documents".into())
    }
}

fn run_zola(mut command: Command) -> Result<(bool, String), String> {
    let mut log: File =
        tempfile::tempfile().map_err(|_| "Could not create Zola diagnostic output")?;
    let stdout = log
        .try_clone()
        .map_err(|_| "Could not capture Zola output")?;
    let stderr = log
        .try_clone()
        .map_err(|_| "Could not capture Zola output")?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .map_err(|_| "Could not start Zola 0.23.6")?;
    let deadline = Instant::now() + BUILD_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Zola failed to finish within the build limit".into());
            }
        }
    };
    log.rewind().map_err(|_| "Could not rewind Zola output")?;
    let mut bytes = Vec::new();
    log.take(8 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read Zola output")?;
    Ok((exit.success(), String::from_utf8_lossy(&bytes).into_owned()))
}
