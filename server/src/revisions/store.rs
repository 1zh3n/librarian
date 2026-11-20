use super::git;
use silverbullet_server_common::RevisionsMode;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const COMMITTER_NAME: &str = "SilverBullet";
const COMMITTER_EMAIL: &str = "silverbullet@silverbullet.local";

pub(super) fn commit_env<'a>(author: Option<(&'a str, &'a str)>) -> [(&'static str, &'a str); 4] {
    let (name, email) = author.unwrap_or((COMMITTER_NAME, COMMITTER_EMAIL));
    [
        ("GIT_AUTHOR_NAME", name),
        ("GIT_AUTHOR_EMAIL", email),
        ("GIT_COMMITTER_NAME", COMMITTER_NAME),
        ("GIT_COMMITTER_EMAIL", COMMITTER_EMAIL),
    ]
}

pub struct StagedChange {
    pub status: char,
    pub path: String,
    pub renamed_from: Option<String>,
}

pub struct RevisionStore {
    root: PathBuf,
    repo: Mutex<Option<PathBuf>>,
    mode: RevisionsMode,
    auto_commit: bool,
    exact_markdown: bool,
}

/// The work-tree root of the repository containing `path`, if any.
/// A filesystem walk-up — never spawns git, so it works without the binary.
pub fn discover_repo_root(path: &Path) -> Option<PathBuf> {
    let mut cur = path.canonicalize().ok()?;
    loop {
        if cur.join(".git").exists() {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn managed_marker(repo: &Path) -> bool {
    marker_state(repo).unwrap_or(false)
}

const IN_PROGRESS_MARKERS: [&str; 4] = [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
];

/// `.git` is a file rather than a directory inside a worktree or submodule,
/// so the real git dir has to be asked for rather than assumed.
pub(crate) fn merge_in_progress(repo: &Path) -> bool {
    let Ok(git_dir) = git::run(repo, &["rev-parse", "--absolute-git-dir"], &[]) else {
        return false;
    };
    let git_dir = Path::new(git_dir.trim());
    IN_PROGRESS_MARKERS.iter().any(|m| git_dir.join(m).exists())
}

/// `None` when the key has never been set; `Some` reflects its current value.
/// A user-cleared `false` must stay `false` on re-open, not be re-marked.
fn marker_state(repo: &Path) -> Option<bool> {
    git::run(
        repo,
        &["config", "--local", "--get", "silverbullet.managed"],
        &[],
    )
    .ok()
    .map(|v| v.trim() == "true")
}

impl RevisionStore {
    pub fn open(root: &Path, mode: RevisionsMode) -> Option<RevisionStore> {
        if mode == RevisionsMode::Disabled {
            return None;
        }
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let discovered = discover_repo_root(&root);
        let (repo, auto_commit) = match (mode, discovered) {
            (RevisionsMode::Managed, Some(repo_root)) => {
                if repo_root != root {
                    tracing::warn!(
                        "Managed revisions on a space nested in a larger repo at {repo_root:?}; \
                         treating as unmanaged"
                    );
                    (Some(repo_root), false)
                } else if !git::available() {
                    tracing::warn!("Managed revisions configured but git is not installed");
                    (Some(repo_root), false)
                } else {
                    let auto_commit = match marker_state(&repo_root) {
                        Some(v) => v,
                        None => match git::run(
                            &repo_root,
                            &["config", "--local", "silverbullet.managed", "true"],
                            &[],
                        ) {
                            Ok(_) => true,
                            Err(e) => {
                                tracing::warn!("Cannot mark repo as managed: {e}");
                                false
                            }
                        },
                    };
                    (Some(repo_root), auto_commit)
                }
            }
            (RevisionsMode::Managed, None) => {
                if !git::available() {
                    tracing::warn!("Managed revisions configured but git is not installed");
                    return None;
                }
                match git::run(&root, &["init", "-q"], &[]) {
                    Ok(_) => {
                        if let Err(e) = git::run(
                            &root,
                            &["config", "--local", "silverbullet.managed", "true"],
                            &[],
                        ) {
                            tracing::warn!("Cannot mark fresh repo as managed: {e}");
                        }
                        (Some(root.clone()), managed_marker(&root))
                    }
                    Err(e) => {
                        tracing::warn!("git init failed for {root:?}: {e}");
                        return None;
                    }
                }
            }
            (RevisionsMode::Unmanaged, repo_root) => (repo_root, false),
            (RevisionsMode::Disabled, _) => unreachable!(),
        };
        Some(RevisionStore {
            root,
            repo: Mutex::new(repo),
            mode,
            auto_commit,
            exact_markdown: false,
        })
    }

    pub(crate) fn with_exact_markdown(mut self, enabled: bool) -> Self {
        self.exact_markdown = enabled;
        self
    }

    pub fn mode(&self) -> RevisionsMode {
        self.mode
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn auto_commit_allowed(&self) -> bool {
        self.auto_commit
    }

    /// Repo root; dormant Unmanaged stores re-discover on access.
    pub fn repo_root(&self) -> Option<PathBuf> {
        let mut guard = self.repo.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() && self.mode == RevisionsMode::Unmanaged {
            *guard = discover_repo_root(&self.root);
        }
        guard.clone()
    }

    /// Repo-root-relative path for a space-relative path.
    pub fn rel(&self, space_path: &str) -> String {
        let prefix = self
            .repo_root()
            .and_then(|repo| {
                self.root
                    .strip_prefix(&repo)
                    .ok()
                    .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            })
            .filter(|p| !p.is_empty());
        match prefix {
            Some(p) => format!("{p}/{space_path}"),
            None => space_path.to_string(),
        }
    }

    pub fn head_exists(&self) -> bool {
        self.repo_root()
            .map(|repo| {
                git::check(&repo, &["rev-parse", "--verify", "--quiet", "HEAD"], 1).unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn prepare_commit(&self) -> Result<PathBuf, String> {
        let repo = self.repo_root().ok_or("no repository")?;
        if !self.auto_commit {
            return Err("auto-commit not allowed for this repo".to_string());
        }
        if self.head_exists() && !git::check(&repo, &["symbolic-ref", "--quiet", "HEAD"], 1)? {
            return Err("HEAD is detached; auto-commit paused".to_string());
        }
        if merge_in_progress(&repo) {
            return Err("merge in progress; auto-commit paused".to_string());
        }
        Ok(repo)
    }

    fn commit_staged(
        &self,
        repo: &Path,
        author_name: &str,
        author_email: &str,
        message: &str,
    ) -> Result<Option<String>, String> {
        if git::check(repo, &["diff", "--cached", "--quiet"], 1)? {
            return Ok(None);
        }
        git::run(
            repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--no-verify",
                "-m",
                message,
            ],
            &commit_env(Some((author_name, author_email))),
        )?;
        let id = git::run(repo, &["rev-parse", "HEAD"], &[])?;
        Ok(Some(id.trim().to_string()))
    }

    fn stage_paths(
        &self,
        repo: &Path,
        paths: &[String],
        env: &[(&str, &str)],
    ) -> Result<(), String> {
        let rels: Vec<String> = paths.iter().map(|path| self.rel(path)).collect();
        let present: Vec<bool> = rels
            .iter()
            .map(|rel| match std::fs::symlink_metadata(repo.join(rel)) {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(format!("failed to inspect revision path {rel}: {error}")),
            })
            .collect::<Result<_, _>>()?;
        let missing_pathspecs: Vec<String> = rels
            .iter()
            .zip(&present)
            .filter(|(_, present)| !**present)
            .map(|(rel, _)| format!(":(literal){rel}"))
            .collect();
        let tracked: HashSet<Vec<u8>> = if missing_pathspecs.is_empty() {
            HashSet::new()
        } else {
            let mut args: Vec<&str> = vec!["ls-files", "-z", "--cached", "--"];
            args.extend(missing_pathspecs.iter().map(String::as_str));
            git::run_bytes(repo, &args, env)?
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(<[u8]>::to_vec)
                .collect()
        };
        let stageable: Vec<String> = rels
            .into_iter()
            .zip(present)
            .filter(|(rel, present)| *present || tracked.contains(rel.as_bytes()))
            .map(|(rel, _)| format!(":(literal){rel}"))
            .collect();
        if stageable.is_empty() {
            return Ok(());
        }
        let mut add_args: Vec<&str> = vec!["add", "-A", "-f", "--"];
        add_args.extend(stageable.iter().map(String::as_str));
        git::run(repo, &add_args, env)?;
        Ok(())
    }

    fn stage_exact_paths(&self, index: &ExactIndex, paths: &[String]) -> Result<(), String> {
        let mut ordinary = Vec::new();
        for path in paths {
            let relative = self.rel(path);
            if path.ends_with(".md") {
                let location = index.repo.join(&relative);
                match fs::symlink_metadata(&location) {
                    Ok(metadata) if metadata.is_file() => {
                        // Git will not stage files inside a symlinked directory.
                        if location.canonicalize().map_err(|error| error.to_string())? == location {
                            index.stage_markdown(&relative, &metadata, None)?;
                        }
                        continue;
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            ordinary.push(path.clone());
        }
        // Limit argument count for bulk snapshots and keep the paths literal.
        for batch in ordinary.chunks(8) {
            self.stage_paths(&index.repo, batch, &index.env())?;
        }
        Ok(())
    }

    /// Commit the current on-disk state of `paths` (space-relative). Missing
    /// files become deletions. Returns Ok(None) when nothing changed.
    pub fn commit_batch(
        &self,
        author_name: &str,
        author_email: &str,
        message: &str,
        paths: &[String],
    ) -> Result<Option<String>, String> {
        if paths.is_empty() {
            return Ok(None);
        }
        let repo = self.prepare_commit()?;
        if self.exact_markdown {
            let mut index = ExactIndex::open(repo)?;
            self.stage_exact_paths(&index, paths)?;
            index.commit(author_name, author_email, message)?;
            return index.publish();
        }
        self.stage_paths(&repo, paths, &[])?;
        self.commit_staged(&repo, author_name, author_email, message)
    }

    /// Like [`Self::commit_batch`], but derives the message from what
    /// actually landed in the index instead of taking one from the caller.
    /// A classification failure must never cost a commit, so it falls back
    /// to the generic multi-path summary rather than erroring out.
    pub fn commit_batch_auto(
        &self,
        author_name: &str,
        author_email: &str,
        paths: &[String],
    ) -> Result<Option<String>, String> {
        if paths.is_empty() {
            return Ok(None);
        }
        let repo = self.prepare_commit()?;
        if self.exact_markdown {
            let mut index = ExactIndex::open(repo)?;
            self.stage_exact_paths(&index, paths)?;
            let message = self.auto_message(&index.repo, paths, &index.env());
            index.commit(author_name, author_email, &message)?;
            return index.publish();
        }
        self.stage_paths(&repo, paths, &[])?;
        let message = self.auto_message(&repo, paths, &[]);
        self.commit_staged(&repo, author_name, author_email, &message)
    }

    fn auto_message(&self, repo: &Path, paths: &[String], env: &[(&str, &str)]) -> String {
        self.classify_staged(repo, paths, env)
            .ok()
            .and_then(|c| derive_message(&c))
            .unwrap_or_else(|| fallback_message(paths))
    }

    /// `-z` records are `<status>\0<path>`, except renames and copies, which
    /// carry a second path -- the destination, which is the one that now exists.
    fn classify_staged(
        &self,
        repo: &Path,
        paths: &[String],
        env: &[(&str, &str)],
    ) -> Result<Vec<StagedChange>, String> {
        let mut args: Vec<&str> = vec!["diff", "--cached", "--name-status", "-z", "--"];
        // A private index starts at HEAD and contains only this batch's paths.
        let rels: Vec<String> = if env.is_empty() {
            paths
                .iter()
                .map(|p| format!(":(literal){}", self.rel(p)))
                .collect()
        } else {
            Vec::new()
        };
        args.extend(rels.iter().map(|s| s.as_str()));
        let out = git::run(repo, &args, env)?;
        let mut fields = out.split('\0').filter(|f| !f.is_empty());
        let mut changes = Vec::new();
        while let Some(status) = fields.next() {
            let code = status.chars().next().unwrap_or('M');
            let first = match fields.next() {
                Some(p) => p,
                None => break,
            };
            let (path, renamed_from) = if matches!(code, 'R' | 'C') {
                match fields.next() {
                    Some(dest) => (dest, Some(first.to_string())),
                    None => (first, None),
                }
            } else {
                (first, None)
            };
            changes.push(StagedChange {
                status: code,
                path: path.to_string(),
                renamed_from,
            });
        }
        Ok(changes)
    }

    /// Commit everything under the space that differs from HEAD, whether or
    /// not the engine ever observed it changing. Unlike [`Self::commit_batch`],
    /// which names every path it stages, this one adds by directory, so it
    /// must not force past `.gitignore` -- a blanket `-f` would sweep in
    /// whatever else lives in the folder.
    pub fn commit_all(
        &self,
        author_name: &str,
        author_email: &str,
        message: &str,
    ) -> Result<Option<String>, String> {
        let repo = self.prepare_commit()?;
        if self.exact_markdown {
            let mut index = ExactIndex::open(repo)?;
            let files = git::run_bytes(
                &index.repo,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
                &index.env(),
            )?;
            let mut paths: Vec<_> = files
                .split(|&byte| byte == 0)
                .filter(|path| !path.is_empty())
                .filter_map(|path| std::str::from_utf8(path).ok().map(str::to_owned))
                .collect();
            paths.sort_unstable();
            paths.dedup();
            self.stage_exact_paths(&index, &paths)?;
            index.commit(author_name, author_email, message)?;
            return index.publish();
        }

        let prefix = self.rel("");
        let pathspec = format!(":(literal){prefix}");
        let mut add_args: Vec<&str> = vec!["add", "-A", "--"];
        if !prefix.is_empty() {
            add_args.push(&pathspec);
        }
        git::run(&repo, &add_args, &[])?;

        self.commit_staged(&repo, author_name, author_email, message)
    }

    pub(crate) fn prepare_restore(
        &self,
        path: &str,
        author: (&str, &str),
        checkpoint_author: Option<(&str, &str)>,
        current: &[u8],
        restored: &[u8],
    ) -> Result<PreparedCommit, String> {
        let mut index = ExactIndex::open(self.prepare_commit()?)?;
        let relative = self.rel(path);
        let metadata =
            fs::symlink_metadata(index.repo.join(&relative)).map_err(|error| error.to_string())?;
        index.stage_markdown(&relative, &metadata, Some(current))?;
        let checkpoint_message = checkpoint_author
            .map(|_| self.auto_message(&index.repo, &[path.to_owned()], &index.env()))
            .unwrap_or_else(|| "Save before restoring version".to_string());
        let (name, email) = checkpoint_author.unwrap_or(author);
        index.commit(name, email, &checkpoint_message)?;
        index.stage_markdown(&relative, &metadata, Some(restored))?;
        index.commit(author.0, author.1, "Restore document version")?;
        index
            .prepare()?
            .ok_or_else(|| "Restoring the document produced no Git commit".to_string())
    }

    pub(crate) fn exact_markdown_uncommitted(&self, path: &str) -> Result<Option<bool>, String> {
        if !self.exact_markdown || !self.auto_commit_allowed() {
            return Ok(None);
        }
        let repo = self.repo_root().ok_or("no repository")?;
        let relative = self.rel(path);
        let revision = format!("HEAD:{relative}");
        if !git::check(&repo, &["rev-parse", "--verify", "--quiet", &revision], 1)? {
            return Ok(Some(true));
        }
        let committed = git::run(&repo, &["rev-parse", &revision], &[])?;
        let working = git::run(
            &repo,
            &["hash-object", "--no-filters", "--", &relative],
            &[],
        )?;
        Ok(Some(committed.trim() != working.trim()))
    }
}

struct IndexLock(PathBuf);

impl IndexLock {
    fn acquire(index: &Path) -> Result<Self, String> {
        let mut path = index.as_os_str().to_owned();
        path.push(".lock");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Could not lock the Git index: {error}"))?;
        Ok(Self(path.into()))
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// A private index starts at HEAD, so a revision contains only the paths
/// Librarian stages. The Git index lock keeps external writes from changing
/// the real index while we prepare its corresponding per-path update.
struct ExactIndex {
    repo: PathBuf,
    directory: tempfile::TempDir,
    index: PathBuf,
    private_index: String,
    branch: String,
    base: Option<String>,
    base_tree: String,
    tip: Option<String>,
    tree: String,
}

impl ExactIndex {
    fn open(repo: PathBuf) -> Result<Self, String> {
        let index = git::run(
            &repo,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            &[],
        )?;
        let index = PathBuf::from(index.trim_end_matches(['\n', '\r']));
        let directory = tempfile::tempdir_in(index.parent().ok_or("missing Git index directory")?)
            .map_err(|error| error.to_string())?;
        let private_index = git_path(directory.path().join("commit-index"))?;
        let branch = git::run(&repo, &["symbolic-ref", "--quiet", "HEAD"], &[])?
            .trim()
            .to_owned();
        let base = git::check(&repo, &["rev-parse", "--verify", "--quiet", &branch], 1)?
            .then(|| git::run(&repo, &["rev-parse", &branch], &[]))
            .transpose()?
            .map(|commit| commit.trim().to_owned());
        let env = [("GIT_INDEX_FILE", private_index.as_str())];
        git::run(
            &repo,
            &["read-tree", base.as_deref().unwrap_or("--empty")],
            &env,
        )?;
        let tree = git::run(&repo, &["write-tree"], &env)?.trim().to_owned();
        Ok(Self {
            repo,
            directory,
            index,
            private_index,
            branch,
            tip: base.clone(),
            base,
            base_tree: tree.clone(),
            tree,
        })
    }

    fn env(&self) -> [(&str, &str); 1] {
        [("GIT_INDEX_FILE", &self.private_index)]
    }

    fn stage_markdown(
        &self,
        path: &str,
        metadata: &fs::Metadata,
        contents: Option<&[u8]>,
    ) -> Result<(), String> {
        let hash = if let Some(contents) = contents {
            let mut input =
                tempfile::tempfile_in(self.directory.path()).map_err(|error| error.to_string())?;
            input
                .write_all(contents)
                .and_then(|()| input.rewind())
                .map_err(|error| error.to_string())?;
            git::run_with_input(
                &self.repo,
                &["hash-object", "-w", "--no-filters", "--stdin"],
                &[],
                input,
            )?
        } else {
            git::run(
                &self.repo,
                &["hash-object", "-w", "--no-filters", "--", path],
                &[],
            )?
        };
        git::run(
            &self.repo,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                markdown_mode(metadata),
                hash.trim(),
                path,
            ],
            &self.env(),
        )?;
        Ok(())
    }

    fn commit(&mut self, name: &str, email: &str, message: &str) -> Result<(), String> {
        let tree = git::run(&self.repo, &["write-tree"], &self.env())?;
        let tree = tree.trim();
        if self.tree == tree {
            return Ok(());
        }
        let mut args = vec![
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            tree,
            "-m",
            message,
        ];
        if let Some(parent) = self.tip.as_deref() {
            args.extend(["-p", parent]);
        }
        let commit = git::run(&self.repo, &args, &commit_env(Some((name, email))))?;
        self.tip = Some(commit.trim().to_owned());
        self.tree = tree.to_owned();
        Ok(())
    }

    fn prepare(self) -> Result<Option<PreparedCommit>, String> {
        if self.tip == self.base {
            return Ok(None);
        }
        let tip = self.tip.clone().ok_or("missing Git commit")?;
        let lock = IndexLock::acquire(&self.index)?;
        if git::run(&self.repo, &["symbolic-ref", "--quiet", "HEAD"], &[])?.trim() != self.branch
            || merge_in_progress(&self.repo)
        {
            return Err(
                "Git branch changed or a merge started while preparing the revision".into(),
            );
        }
        let working_index = self.directory.path().join("working-index");
        let working_path = git_path(working_index.clone())?;
        let working_env = [("GIT_INDEX_FILE", working_path.as_str())];
        match fs::copy(&self.index, &working_index) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                git::run(&self.repo, &["read-tree", "--empty"], &working_env)?;
            }
            Err(error) => return Err(error.to_string()),
        }
        // Apply only the committed tree transition to the copy. Git carries
        // unrelated staged entries forward and keeps the worktree untouched.
        git::run(
            &self.repo,
            &["read-tree", "-i", "-m", &self.base_tree, &self.tree],
            &working_env,
        )?;
        Ok(Some(PreparedCommit {
            index: self,
            working_index,
            tip,
            _lock: lock,
        }))
    }

    fn publish(self) -> Result<Option<String>, String> {
        self.prepare()?.map(|commit| commit.publish()).transpose()
    }
}

fn git_path(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "Git index path is not UTF-8".to_string())
}

fn markdown_mode(metadata: &fs::Metadata) -> &'static str {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o100 != 0 {
            return "100755";
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    "100644"
}

pub(crate) struct PreparedCommit {
    index: ExactIndex,
    working_index: PathBuf,
    tip: String,
    _lock: IndexLock,
}

impl PreparedCommit {
    pub(crate) fn publish(&self) -> Result<String, String> {
        let index = &self.index;
        git::run(
            &index.repo,
            &[
                "update-ref",
                "-m",
                "Librarian revision",
                &index.branch,
                &self.tip,
                index.base.as_deref().unwrap_or(""),
            ],
            &[("SB_GIT_NO_HOOKS", "1")],
        )?;
        // The branch is already published. A local filesystem failure here
        // cannot roll back the document or report the commit as unwritten.
        if let Err(error) = fs::rename(&self.working_index, &index.index) {
            tracing::warn!(
                "Librarian revision committed, but the Git index could not be refreshed: {error}"
            );
        }
        Ok(self.tip.clone())
    }
}

fn noun(paths: &[&str], count: usize) -> &'static str {
    let page = paths.iter().all(|p| p.ends_with(".md"));
    match (page, count) {
        (true, 1) => "page",
        (true, _) => "pages",
        (false, 1) => "file",
        (false, _) => "files",
    }
}

fn derive_message(changes: &[StagedChange]) -> Option<String> {
    if changes.is_empty() {
        return None;
    }
    if changes.len() == 1 {
        let c = &changes[0];
        if c.status == 'R' {
            return Some(match &c.renamed_from {
                Some(from) => format!("Rename {from} \u{2192} {}", c.path),
                None => format!("Rename {}", c.path),
            });
        }
        let verb = match c.status {
            'A' => "Create",
            'D' => "Delete",
            _ => "Update",
        };
        return Some(format!("{verb} {}", c.path));
    }
    let group = |code: char| -> Vec<&str> {
        changes
            .iter()
            .filter(|c| {
                if code == 'M' {
                    !matches!(c.status, 'A' | 'D' | 'R')
                } else {
                    c.status == code
                }
            })
            .map(|c| c.path.as_str())
            .collect()
    };
    let parts: Vec<(&str, Vec<&str>)> = vec![
        ("update", group('M')),
        ("create", group('A')),
        ("delete", group('D')),
        ("rename", group('R')),
    ];
    let present: Vec<(&str, Vec<&str>)> =
        parts.into_iter().filter(|(_, v)| !v.is_empty()).collect();
    let (lead_verb, lead) = present.first()?;
    let lead_verb: &str = lead_verb;
    let all: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    let mut out = format!(
        "{}{} {} {}",
        lead_verb[..1].to_uppercase(),
        &lead_verb[1..],
        lead.len(),
        noun(&all, lead.len())
    );
    for (verb, group) in present.iter().skip(1) {
        out.push_str(&format!(", {verb} {}", group.len()));
    }
    Some(out)
}

/// Message used when classification is unavailable or produced nothing.
fn fallback_message(paths: &[String]) -> String {
    match paths.len() {
        1 => format!("Update {}", paths[0]),
        2 => format!("Update {}, {}", paths[0], paths[1]),
        n => format!("Update {}, {} (+{} more)", paths[0], paths[1], n - 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use silverbullet_server_common::RevisionsMode;
    use std::path::Path;

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn disabled_mode_yields_no_store() {
        let dir = tempfile::tempdir().unwrap();
        assert!(RevisionStore::open(dir.path(), RevisionsMode::Disabled).is_none());
    }

    #[test]
    fn managed_mode_inits_and_marks_repo() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        assert!(dir.path().join(".git").is_dir());
        assert!(store.auto_commit_allowed());
        assert_eq!(
            git_out(dir.path(), &["config", "--local", "silverbullet.managed"]),
            "true"
        );
    }

    #[test]
    fn unmanaged_mode_never_inits_and_never_allows_commits() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Unmanaged).unwrap();
        assert!(!dir.path().join(".git").exists(), "unmanaged must not init");
        assert!(store.repo_root().is_none(), "no repo yet: dormant");
        assert!(!store.auto_commit_allowed());
    }

    #[test]
    fn unmanaged_dormant_picks_up_a_user_created_repo_without_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Unmanaged).unwrap();
        assert!(store.repo_root().is_none());
        git_out(dir.path(), &["init", "-q"]);
        assert!(store.repo_root().is_some(), "re-discovery on access");
    }

    #[test]
    fn managed_marker_cleared_by_user_disables_auto_commit() {
        let dir = tempfile::tempdir().unwrap();
        git_out(dir.path(), &["init", "-q"]);
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        assert!(
            store.auto_commit_allowed(),
            "managed mode marks an existing repo too"
        );
        git_out(
            dir.path(),
            &["config", "--local", "silverbullet.managed", "false"],
        );
        let store2 = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        assert!(
            !store2.auto_commit_allowed(),
            "cleared marker wins over mode"
        );
    }

    #[test]
    fn commit_batch_commits_writes_and_deletes_with_author() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("index.md"), b"# Hello\n").unwrap();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/note.md"), b"v1\n").unwrap();
        let id = store
            .commit_batch(
                "Alice",
                "alice@silverbullet.local",
                "Update 2 files",
                &["index.md".into(), "sub/note.md".into()],
            )
            .unwrap();
        assert!(id.is_some());

        std::fs::remove_file(dir.path().join("sub/note.md")).unwrap();
        let id2 = store
            .commit_batch(
                "Bob",
                "bob@silverbullet.local",
                "Delete sub/note.md",
                &["sub/note.md".into()],
            )
            .unwrap();
        assert!(id2.is_some());

        assert_eq!(
            git_out(dir.path(), &["log", "-1", "--format=%an <%ae>|%cn"]),
            "Bob <bob@silverbullet.local>|SilverBullet"
        );
        assert_eq!(git_out(dir.path(), &["log", "--format=%an"]), "Bob\nAlice");
        assert_eq!(
            git_out(dir.path(), &["status", "--porcelain"]),
            "",
            "clean tree after commit"
        );
        let files = git_out(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(!files.contains("sub/note.md"), "{files}");
    }

    #[test]
    fn commit_batch_with_no_effective_change_creates_no_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("a.md"), b"x").unwrap();
        store
            .commit_batch("A", "a@x", "first", &["a.md".into()])
            .unwrap();
        let id = store
            .commit_batch("A", "a@x", "again", &["a.md".into()])
            .unwrap();
        assert!(
            id.is_none(),
            "identical content must not produce an empty commit"
        );
    }

    #[test]
    fn commit_batch_with_no_paths_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join(".gitignore"), b"ignored.md\n").unwrap();
        std::fs::write(dir.path().join("ignored.md"), b"x").unwrap();
        std::fs::write(dir.path().join("tracked.md"), b"x").unwrap();

        let id = store.commit_batch("A", "a@x", "noop", &[]).unwrap();
        assert!(id.is_none());

        let status = git_out(dir.path(), &["status", "--porcelain", "--ignored"]);
        assert!(status.contains("?? tracked.md"), "{status}");
        assert!(status.contains("!! ignored.md"), "{status}");

        let head = std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .output()
            .unwrap();
        assert!(!head.status.success(), "no commit should exist");
    }

    #[test]
    fn commit_batch_ignores_a_vanished_untracked_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("gone.md"), b"ephemeral").unwrap();
        std::fs::remove_file(dir.path().join("gone.md")).unwrap();

        let id = store
            .commit_batch_auto("A", "a@x", &["gone.md".into()])
            .unwrap();

        assert!(id.is_none());
        assert!(!store.head_exists(), "no commit should exist");
    }

    #[test]
    fn commit_batch_commits_a_live_path_beside_a_vanished_untracked_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("gone.md"), b"ephemeral").unwrap();
        std::fs::remove_file(dir.path().join("gone.md")).unwrap();
        std::fs::write(dir.path().join("live.md"), b"kept").unwrap();

        let id = store
            .commit_batch_auto("A", "a@x", &["gone.md".into(), "live.md".into()])
            .unwrap();

        assert!(id.is_some());
        assert_eq!(
            git_out(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]),
            "live.md"
        );
    }

    #[test]
    fn commit_batch_handles_literal_pathspecs() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::create_dir(dir.path().join("nested space")).unwrap();
        let paths = [
            ":weird.md",
            "*.md",
            "[bracket].md",
            "-leading.md",
            "space name.md",
            "nested space/note.md",
        ];
        for path in paths {
            std::fs::write(dir.path().join(path), b"x").unwrap();
        }
        let id = store
            .commit_batch("A", "a@x", "literal paths", &paths.map(str::to_string))
            .unwrap();
        assert!(id.is_some());
        let files = git_out(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]);
        for path in paths {
            assert!(files.lines().any(|line| line == path), "{files}");
        }

        for path in paths {
            std::fs::remove_file(dir.path().join(path)).unwrap();
        }
        let id = store
            .commit_batch(
                "A",
                "a@x",
                "delete literal paths",
                &paths.map(str::to_string),
            )
            .unwrap();
        assert!(id.is_some());
        assert_eq!(
            git_out(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]),
            ""
        );
    }

    #[cfg(unix)]
    #[test]
    fn commit_batch_stages_a_broken_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        symlink("missing-target.md", dir.path().join("link.md")).unwrap();

        let id = store
            .commit_batch("A", "a@x", "symlink", &["link.md".into()])
            .unwrap();

        assert!(id.is_some());
        assert!(git_out(dir.path(), &["ls-tree", "HEAD", "link.md"]).starts_with("120000 blob "));
        assert_eq!(
            git_out(dir.path(), &["show", "HEAD:link.md"]),
            "missing-target.md"
        );
    }

    #[test]
    fn commit_batch_stages_past_a_user_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join(".gitignore"), b"notes/\n").unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/x.md"), b"x").unwrap();
        store
            .commit_batch("A", "a@x", "add", &["notes/x.md".into()])
            .unwrap();
        let files = git_out(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(files.contains("notes/x.md"), "{files}");
    }

    #[test]
    fn detached_head_pauses_commits() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("a.md"), b"x").unwrap();
        store
            .commit_batch("A", "a@x", "first", &["a.md".into()])
            .unwrap();
        let head = git_out(dir.path(), &["rev-parse", "HEAD"]);
        git_out(dir.path(), &["checkout", "-q", "--detach", &head]);
        std::fs::write(dir.path().join("a.md"), b"y").unwrap();
        assert!(store
            .commit_batch("A", "a@x", "second", &["a.md".into()])
            .is_err());
    }

    #[test]
    fn merge_in_progress_pauses_commits() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("note.md"), "base\n").unwrap();
        store
            .commit_batch("A", "a@x.test", "base", &["note.md".into()])
            .unwrap();

        git_out(dir.path(), &["checkout", "-b", "other"]);
        std::fs::write(dir.path().join("note.md"), "theirs\n").unwrap();
        store
            .commit_batch("B", "b@x.test", "theirs", &["note.md".into()])
            .unwrap();
        git_out(dir.path(), &["checkout", "-"]);
        std::fs::write(dir.path().join("note.md"), "ours\n").unwrap();
        store
            .commit_batch("A", "a@x.test", "ours", &["note.md".into()])
            .unwrap();

        let error = git::run(
            dir.path(),
            &[
                "-c",
                "user.name=Sample",
                "-c",
                "user.email=sample@example.test",
                "merge",
                "other",
            ],
            &[],
        )
        .unwrap_err();
        assert!(merge_in_progress(dir.path()), "merge failed: {error}");

        let err = store
            .commit_batch("A", "a@x.test", "should not land", &["note.md".into()])
            .unwrap_err();
        assert!(err.contains("merge"), "got: {err}");

        let log = git_out(dir.path(), &["log", "--oneline"]);
        assert!(!log.contains("should not land"));
    }

    #[test]
    fn space_as_subfolder_of_a_larger_repo_maps_paths_via_prefix() {
        let dir = tempfile::tempdir().unwrap();
        git_out(dir.path(), &["init", "-q"]);
        let sub = dir.path().join("docs");
        std::fs::create_dir_all(&sub).unwrap();
        let store = RevisionStore::open(&sub, RevisionsMode::Unmanaged).unwrap();
        assert_eq!(store.rel("index.md"), "docs/index.md");
    }

    #[test]
    fn discover_repo_root_walks_up_without_git() {
        let dir = tempfile::tempdir().unwrap();
        assert!(discover_repo_root(dir.path()).is_none());
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            discover_repo_root(&sub).unwrap(),
            dir.path().canonicalize().unwrap()
        );
    }

    fn message_of(dir: &tempfile::TempDir) -> String {
        git_out(dir.path(), &["log", "-1", "--format=%s"])
    }

    #[test]
    fn derived_message_names_a_single_created_page() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("Alpha.md"), b"hi").unwrap();
        store
            .commit_batch_auto("alice", "alice@x", &["Alpha.md".into()])
            .unwrap();
        assert_eq!(message_of(&dir), "Create Alpha.md");
    }

    #[test]
    fn derived_message_names_an_update_a_deletion_and_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("Alpha.md"), b"hi").unwrap();
        std::fs::write(dir.path().join("Beta.md"), b"yo").unwrap();
        std::fs::write(dir.path().join("Gamma.md"), b"same content\n").unwrap();
        store
            .commit_batch_auto(
                "alice",
                "alice@x",
                &["Alpha.md".into(), "Beta.md".into(), "Gamma.md".into()],
            )
            .unwrap();

        std::fs::write(dir.path().join("Alpha.md"), b"changed").unwrap();
        store
            .commit_batch_auto("alice", "alice@x", &["Alpha.md".into()])
            .unwrap();
        assert_eq!(message_of(&dir), "Update Alpha.md");

        std::fs::remove_file(dir.path().join("Beta.md")).unwrap();
        store
            .commit_batch_auto("alice", "alice@x", &["Beta.md".into()])
            .unwrap();
        assert_eq!(message_of(&dir), "Delete Beta.md");

        // Identical content, matching read.rs's rename tests, so git's
        // rename detector fires at 100% similarity and this can't go flaky.
        std::fs::rename(dir.path().join("Gamma.md"), dir.path().join("Delta.md")).unwrap();
        store
            .commit_batch_auto("alice", "alice@x", &["Gamma.md".into(), "Delta.md".into()])
            .unwrap();
        assert_eq!(message_of(&dir), "Rename Gamma.md \u{2192} Delta.md");
    }

    #[test]
    fn derived_message_counts_a_mixed_batch() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        for name in ["a.md", "b.md", "c.md"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        store
            .commit_batch_auto(
                "alice",
                "alice@x",
                &["a.md".into(), "b.md".into(), "c.md".into()],
            )
            .unwrap();
        assert_eq!(message_of(&dir), "Create 3 pages");

        std::fs::write(dir.path().join("a.md"), b"y").unwrap();
        std::fs::write(dir.path().join("d.md"), b"new").unwrap();
        std::fs::remove_file(dir.path().join("c.md")).unwrap();
        store
            .commit_batch_auto(
                "alice",
                "alice@x",
                &["a.md".into(), "c.md".into(), "d.md".into()],
            )
            .unwrap();
        assert_eq!(message_of(&dir), "Update 1 page, create 1, delete 1");
    }

    #[test]
    fn derived_message_says_file_for_a_non_markdown_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = RevisionStore::open(dir.path(), RevisionsMode::Managed).unwrap();
        std::fs::write(dir.path().join("logo.png"), b"\x89PNG").unwrap();
        std::fs::write(dir.path().join("icon.png"), b"\x89PNG").unwrap();
        store
            .commit_batch_auto("alice", "alice@x", &["logo.png".into(), "icon.png".into()])
            .unwrap();
        assert_eq!(message_of(&dir), "Create 2 files");
    }

    #[test]
    fn fallback_message_names_a_single_path() {
        assert_eq!(fallback_message(&["a.md".into()]), "Update a.md");
    }

    #[test]
    fn fallback_message_lists_two_paths() {
        assert_eq!(
            fallback_message(&["a.md".into(), "b.md".into()]),
            "Update a.md, b.md"
        );
    }

    #[test]
    fn fallback_message_summarizes_more_than_two_paths() {
        assert_eq!(
            fallback_message(&["a.md".into(), "b.md".into(), "c.md".into(), "d.md".into()]),
            "Update a.md, b.md (+2 more)"
        );
    }
}
