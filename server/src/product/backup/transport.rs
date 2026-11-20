use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::{
    revisions::{git, keys},
    state::ServerState,
};
use uuid::Uuid;

use super::{ApiError, Job, Metadata, Mode, StatusCode, Target, REPOS_DIRECTORY};

const LOCAL: [(&str, &str); 3] = [
    ("SB_GIT_PRODUCT_ISOLATED", "1"),
    ("SB_GIT_NO_HOOKS", "1"),
    ("GIT_ALLOW_PROTOCOL", ""),
];

pub(super) fn valid_target(target: &Target) -> bool {
    let branch = target.branch.as_str();
    if branch.is_empty()
        || branch.len() > 200
        || branch.contains([':', '?', '*', '[', '\\', '~', '^'])
        || branch.contains("..")
        || branch.contains("@{")
        || branch.ends_with('.')
        || branch.chars().any(|c| c.is_control() || c.is_whitespace())
        || branch
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
    {
        return false;
    }
    let repository = &target.repository;
    if repository.is_empty() || repository.chars().any(char::is_control) {
        return false;
    }
    if Path::new(repository).is_absolute() {
        return target.ssh.is_none();
    }
    let Some(ssh) = &target.ssh else {
        return false;
    };
    if !repository.starts_with("ssh://")
        || !ssh.identity_file.is_absolute()
        || !ssh.known_hosts_file.is_absolute()
    {
        return false;
    }
    reqwest::Url::parse(repository).is_ok_and(|url| {
        url.host().is_some()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && !url.username().starts_with('-')
            && !url.username().is_empty()
            && url
                .username()
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
            && url.path().len() > 1
            && url
                .path()
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'_' | b'.'))
            && url
                .path()
                .split('/')
                .all(|part| !matches!(part, "." | ".."))
    })
}

pub(super) fn source_repo(state: &ServerState) -> Result<PathBuf, ApiError> {
    let root = Path::new(&state.space_folder_path)
        .canonicalize()
        .map_err(ApiError::internal)?;
    let managed = state
        .revisions
        .as_ref()
        .filter(|engine| engine.store().auto_commit_allowed())
        .and_then(|engine| engine.store().repo_root());
    let git_dir = root.join(".git");
    if managed.and_then(|path| path.canonicalize().ok()).as_ref() != Some(&root)
        || !fs::symlink_metadata(&git_dir).is_ok_and(|meta| meta.is_dir())
        || !git::run(&root, &["rev-parse", "--show-toplevel"], &LOCAL)
            .is_ok_and(|path| Path::new(path.trim()) == root)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "backup_revisions_unavailable",
            "Backup requires an independent managed Workspace repository",
        ));
    }
    Ok(root)
}

fn ensure_dir(path: &Path) -> Result<(), ApiError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        _ => return Err(ApiError::internal("Invalid backup storage directory")),
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == ErrorKind::AlreadyExists
                && fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) =>
        {
            Ok(())
        }
        Err(error) => Err(ApiError::internal(error)),
    }
}

pub(super) fn backup_repo(
    db: &Metadata,
    workspace: &str,
    target: &str,
) -> Result<PathBuf, ApiError> {
    let directory = db.product_file(REPOS_DIRECTORY);
    ensure_dir(&directory)?;
    let workspace = directory.join(workspace);
    ensure_dir(&workspace)?;
    let path = workspace.join(target);
    ensure_dir(&path)?;
    if !path.join("HEAD").exists() {
        git::run(
            &path,
            &[
                "init",
                "--bare",
                "--template=",
                "--initial-branch=backup",
                "--object-format=sha1",
            ],
            &LOCAL,
        )
        .map_err(ApiError::internal)?;
    }
    for name in ["HEAD", "config"] {
        if !fs::symlink_metadata(path.join(name)).is_ok_and(|meta| meta.is_file()) {
            return Err(ApiError::internal("Invalid backup repository control file"));
        }
    }
    for name in ["objects", "refs"] {
        if !fs::symlink_metadata(path.join(name)).is_ok_and(|meta| meta.is_dir()) {
            return Err(ApiError::internal("Invalid backup repository directory"));
        }
    }
    path.canonicalize().map_err(ApiError::internal)
}

pub(super) fn capture(source: &Path, backup: &Path) -> Result<String, ApiError> {
    let commit =
        git::run(source, &["rev-parse", "--verify", "HEAD^{commit}"], &LOCAL).map_err(|_| {
            ApiError::new(
                StatusCode::CONFLICT,
                "backup_no_revision",
                "Save a Workspace revision before starting a backup",
            )
        })?;
    let commit = commit.trim();
    if !object_id(commit) {
        return Err(ApiError::internal("Invalid Workspace revision object"));
    }
    let location = source
        .to_str()
        .ok_or_else(|| ApiError::internal("Workspace repository path is not UTF-8"))?;
    let reference = format!("+{commit}:refs/librarian/source");
    let mut env = LOCAL;
    env[2] = ("GIT_ALLOW_PROTOCOL", "file");
    git::run(
        backup,
        &[
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-auto-gc",
            "--",
            location,
            &reference,
        ],
        &env,
    )
    .map_err(ApiError::internal)?;
    Ok(commit.into())
}

pub(super) fn plan(
    repo: &Path,
    operation: &str,
    mode: Mode,
    source: &str,
    previous: Option<&Job>,
) -> Result<String, ApiError> {
    let mut parent = previous.map(|job| job.planned_commit.clone());
    if matches!(mode, Mode::EachOperation) {
        let range = if let Some(previous) = previous {
            let oldest = &previous.view.source_commit_id;
            let base = git::run(repo, &["merge-base", oldest, source], &LOCAL).unwrap_or_default();
            if base.trim() != oldest {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "backup_source_changed",
                    "Workspace history changed since the previous backup",
                ));
            }
            format!("{oldest}..{source}")
        } else {
            source.to_owned()
        };
        let history = git::run(
            repo,
            &[
                "log",
                "--first-parent",
                "--reverse",
                "--format=%H%x09%(trailers:key=Librarian-Operation-Id,valueonly,separator=%x2C)",
                &range,
            ],
            &LOCAL,
        )
        .map_err(ApiError::internal)?;
        for (revision, trailer) in history.lines().filter_map(|line| line.split_once('\t')) {
            let trailer = trailer.trim();
            if object_id(revision)
                && Uuid::parse_str(trailer).is_ok_and(|id| id.to_string() == trailer)
            {
                let message =
                    format!("Backup Librarian operation\n\nLibrarian-Operation-Id: {trailer}");
                parent = Some(commit_tree(
                    repo,
                    &tree(repo, revision)?,
                    parent.as_deref(),
                    &message,
                )?);
            }
        }
    }
    let final_tree = tree(repo, source)?;
    let equal = parent
        .as_deref()
        .map(|head| tree(repo, head))
        .transpose()?
        .as_deref()
        == Some(&final_tree);
    if !equal {
        let message = format!("Backup Librarian workspace\n\nLibrarian-Backup-Job: {operation}");
        parent = Some(commit_tree(repo, &final_tree, parent.as_deref(), &message)?);
    }
    let head = parent.ok_or_else(|| ApiError::internal("Missing backup commit"))?;
    git::run(
        repo,
        &[
            "update-ref",
            "--no-deref",
            &format!("refs/librarian/jobs/{operation}"),
            &head,
        ],
        &LOCAL,
    )
    .map_err(ApiError::internal)?;
    Ok(head)
}

fn tree(repo: &Path, commit: &str) -> Result<String, ApiError> {
    let tree = git::run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{commit}^{{tree}}"),
        ],
        &LOCAL,
    )
    .map_err(ApiError::internal)?;
    let tree = tree.trim();
    if !object_id(tree) {
        return Err(ApiError::internal("Invalid backup tree object"));
    }
    Ok(tree.into())
}

fn commit_tree(
    repo: &Path,
    tree: &str,
    parent: Option<&str>,
    message: &str,
) -> Result<String, ApiError> {
    let mut args = vec![
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-m",
        message,
    ];
    if let Some(parent) = parent {
        args.extend_from_slice(&["-p", parent]);
    }
    let mut env = LOCAL.to_vec();
    env.extend([
        ("GIT_AUTHOR_NAME", "Librarian Backup"),
        ("GIT_COMMITTER_NAME", "Librarian Backup"),
        ("GIT_AUTHOR_EMAIL", "backup@librarian.invalid"),
        ("GIT_COMMITTER_EMAIL", "backup@librarian.invalid"),
    ]);
    let commit = git::run(repo, &args, &env).map_err(ApiError::internal)?;
    let commit = commit.trim();
    if !object_id(commit) {
        return Err(ApiError::internal("Invalid generated backup commit"));
    }
    Ok(commit.into())
}

fn object_id(id: &str) -> bool {
    id.len() == 40
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub(super) struct Remote<'a> {
    backup: &'a Path,
    repository: String,
    reference: String,
    ssh: Option<String>,
}

impl<'a> Remote<'a> {
    pub(super) fn new(
        target: &Target,
        source: &Path,
        backup: &'a Path,
    ) -> Result<Self, &'static str> {
        let reference = target.reference();
        if git::run(backup, &["check-ref-format", &reference], &LOCAL).is_err() {
            return Err("The configured destination branch is invalid");
        }
        let (repository, ssh) = if let Some(ssh) = &target.ssh {
            for file in [&ssh.identity_file, &ssh.known_hosts_file] {
                if !fs::symlink_metadata(file).is_ok_and(|meta| meta.is_file()) {
                    return Err("The configured backup credentials are unavailable");
                }
            }
            (
                target.repository.clone(),
                Some(keys::pinned_ssh_command(
                    &ssh.identity_file,
                    &ssh.known_hosts_file,
                )),
            )
        } else {
            let path = Path::new(&target.repository)
                .canonicalize()
                .map_err(|_| "The backup target is unavailable")?;
            if path.starts_with(source)
                || source.starts_with(&path)
                || path.starts_with(backup)
                || backup.starts_with(&path)
            {
                return Err("The backup target must be an independent repository");
            }
            let bare = git::run(
                &path,
                &["rev-parse", "--is-bare-repository", "--absolute-git-dir"],
                &LOCAL,
            )
            .map_err(|_| "The backup target is unavailable")?;
            let mut lines = bare.lines();
            if lines.next() != Some("true") || lines.next().map(Path::new) != Some(path.as_path()) {
                return Err("An on-disk backup target must be a bare Git repository");
            }
            (
                path.to_str()
                    .ok_or("The backup target is invalid")?
                    .to_owned(),
                None,
            )
        };
        Ok(Self {
            backup,
            repository,
            reference,
            ssh,
        })
    }

    fn env(&self) -> Vec<(&str, &str)> {
        let mut env = LOCAL.to_vec();
        if let Some(ssh) = self.ssh.as_deref() {
            env[2] = ("GIT_ALLOW_PROTOCOL", "ssh");
            env.push(("GIT_SSH_COMMAND", ssh));
        } else {
            env[2] = ("GIT_ALLOW_PROTOCOL", "file");
        }
        env
    }

    pub(super) fn head(&self) -> Result<Option<String>, &'static str> {
        let result = git::run_network(
            self.backup,
            &[
                "ls-remote",
                "--refs",
                "--heads",
                "--",
                &self.repository,
                &self.reference,
            ],
            &self.env(),
        )
        .map_err(|_| "Could not read the backup target")?;
        let mut lines = result.lines();
        let Some(line) = lines.next() else {
            return Ok(None);
        };
        let (object, reference) = line
            .split_once('\t')
            .ok_or("The backup target returned an invalid branch")?;
        if reference != self.reference || !object_id(object) || lines.next().is_some() {
            return Err("The backup target returned an invalid branch");
        }
        Ok(Some(object.into()))
    }

    pub(super) fn push(&self, commit: &str, prior: Option<&str>) -> Result<(), &'static str> {
        if let Some(prior) = prior {
            let base = git::run(self.backup, &["merge-base", prior, commit], &LOCAL)
                .map_err(|_| "The generated backup history is invalid")?;
            if base.trim() != prior {
                return Err("The generated backup history is invalid");
            }
        }
        let lease = format!(
            "--force-with-lease={}:{}",
            self.reference,
            prior.unwrap_or_default()
        );
        let reference = format!("{commit}:{}", self.reference);
        git::run_network(
            self.backup,
            &[
                "push",
                "--progress",
                "--no-follow-tags",
                &lease,
                "--",
                &self.repository,
                &reference,
            ],
            &self.env(),
        )
        .map(drop)
        .map_err(|_| "The backup push did not complete. Retry this backup.")
    }
}
