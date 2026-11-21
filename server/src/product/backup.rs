mod transport;

use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path as DiskPath, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

use super::{
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::{body, product_read, run, state, DocumentService},
    workspace,
};

const CONFIG_NAME: &str = "backup-targets.json";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const REPOS_DIRECTORY: &str = "backup-repos";

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE backup_settings (
           workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
           target_id TEXT,
           target_key TEXT,
           mode TEXT NOT NULL CHECK (mode IN ('grouped', 'each-operation'))
         );
         CREATE TABLE backup_jobs (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           target_key TEXT NOT NULL,
           source_commit TEXT NOT NULL,
           prior_commit TEXT,
           planned_commit TEXT NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('queued', 'succeeded', 'failed')),
           message TEXT
         );
         CREATE INDEX backup_jobs_workspace ON backup_jobs(workspace_id, target_key);",
    )
}

#[derive(Default, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    #[default]
    Grouped,
    EachOperation,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Grouped => "grouped",
            Self::EachOperation => "each-operation",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Targets {
    targets: Vec<Target>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
    label: String,
    workspace_id: Option<String>,
    repository: String,
    branch: String,
    ssh: Option<Ssh>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ssh {
    identity_file: PathBuf,
    known_hosts_file: PathBuf,
}

impl Target {
    fn key(&self) -> Result<String, ApiError> {
        serde_json::to_vec(&(&self.repository, &self.branch, &self.ssh))
            .map(|binding| sha256_hex(&binding))
            .map_err(ApiError::internal)
    }

    fn reference(&self) -> String {
        format!("refs/heads/{}", self.branch)
    }

    fn summary(self) -> BackupTargetSummary {
        let repository_label = self.github_repository();
        let kind = if repository_label.is_some() {
            BackupTargetKind::Github
        } else if DiskPath::new(&self.repository).is_absolute() {
            BackupTargetKind::Local
        } else {
            BackupTargetKind::Git
        };
        BackupTargetSummary {
            id: self.id,
            label: self.label,
            kind,
            repository_label,
            branch: self.branch,
        }
    }

    fn github_repository(&self) -> Option<String> {
        let url = reqwest::Url::parse(&self.repository).ok()?;
        let host = url.host_str()?;
        let github_ssh =
            host.eq_ignore_ascii_case("github.com") && matches!(url.port(), None | Some(22));
        let github_ssh_over_https =
            host.eq_ignore_ascii_case("ssh.github.com") && url.port() == Some(443);
        if url.scheme() != "ssh"
            || url.username() != "git"
            || !(github_ssh || github_ssh_over_https)
        {
            return None;
        }
        let (owner, repository) = url.path().strip_prefix('/')?.split_once('/')?;
        let repository = repository.strip_suffix(".git").unwrap_or(repository);
        if owner.is_empty()
            || !owner
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || repository.is_empty()
            || repository.contains('/')
        {
            return None;
        }
        Some(format!("{owner}/{repository}"))
    }
}

fn load_targets(metadata: &Metadata, workspace: &str) -> Result<Vec<Target>, ApiError> {
    let path = metadata.product_file(CONFIG_NAME);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_CONFIG_BYTES => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        _ => {
            return Err(ApiError::internal(
                "Invalid deployment backup configuration file",
            ))
        }
    }
    let bytes = fs::read(path).map_err(ApiError::internal)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ApiError::internal(
            "Deployment backup configuration is too large",
        ));
    }
    let Targets { mut targets } = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::internal("Invalid deployment backup configuration"))?;
    // Old deployment entries remain readable, but only an explicit Workspace
    // binding can authorize access to a target.
    targets.retain(|target| {
        target
            .workspace_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
    });
    let mut ids = HashSet::new();
    let mut endpoints = HashSet::new();
    for target in &targets {
        if target.id.is_empty()
            || target.id.len() > 64
            || !target
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || target.label.trim().is_empty()
            || target.label.chars().any(char::is_control)
            || !ids.insert(&target.id)
            || !endpoints.insert((&target.repository, &target.branch))
            || !transport::valid_target(target)
        {
            return Err(ApiError::internal(
                "Invalid or duplicate deployment backup target",
            ));
        }
    }
    targets.retain(|target| target.workspace_id.as_deref() == Some(workspace));
    targets.sort_unstable_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
    Ok(targets)
}

#[derive(Default)]
struct Settings {
    target_id: Option<String>,
    target_key: Option<String>,
    mode: Mode,
}

impl Settings {
    fn load(metadata: &Metadata, workspace: &str) -> Result<Self, ApiError> {
        Ok(metadata
            .connection()?
            .query_row(
                "SELECT target_id, target_key, mode FROM backup_settings WHERE workspace_id = ?1",
                [workspace],
                |row| {
                    Ok(Self {
                        target_id: row.get(0)?,
                        target_key: row.get(1)?,
                        mode: match row.get::<_, String>(2)?.as_str() {
                            "grouped" => Mode::Grouped,
                            "each-operation" => Mode::EachOperation,
                            _ => return Err(rusqlite::Error::InvalidQuery),
                        },
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    fn selected<'a>(&self, targets: &'a [Target]) -> Result<&'a Target, ApiError> {
        let target = targets
            .iter()
            .find(|target| Some(&target.id) == self.target_id.as_ref())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "backup_target_required",
                    "Choose an available backup target",
                )
            })?;
        if self.target_key.as_deref() != Some(target.key()?.as_str()) {
            return Err(target_changed());
        }
        Ok(target)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    targets: Vec<BackupTargetSummary>,
    target_id: Option<String>,
    target_needs_selection: bool,
    mode: Mode,
    last_job: Option<BackupJob>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupTargetSummary {
    id: String,
    label: String,
    kind: BackupTargetKind,
    repository_label: Option<String>,
    branch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum BackupTargetKind {
    Github,
    Git,
    Local,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupJob {
    id: String,
    workspace_id: String,
    status: String,
    source_commit_id: String,
    commit_id: Option<String>,
    message: Option<String>,
}

struct Job {
    view: BackupJob,
    target_key: String,
    prior_commit: Option<String>,
    planned_commit: String,
}

impl Job {
    const SELECT: &str = "SELECT id, workspace_id, status, source_commit, planned_commit, message, target_key, prior_commit FROM backup_jobs";

    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let status: String = row.get(2)?;
        let planned_commit: String = row.get(4)?;
        Ok(Self {
            view: BackupJob {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                source_commit_id: row.get(3)?,
                commit_id: (status == "succeeded").then(|| planned_commit.clone()),
                status,
                message: row.get(5)?,
            },
            target_key: row.get(6)?,
            prior_commit: row.get(7)?,
            planned_commit,
        })
    }

    fn load(metadata: &Metadata, id: &str) -> Result<Option<Self>, ApiError> {
        Ok(metadata
            .connection()?
            .query_row(
                &format!("{} WHERE id = ?1", Self::SELECT),
                [id],
                Self::from_row,
            )
            .optional()?)
    }

    fn latest_for_target(
        metadata: &Metadata,
        workspace: &str,
        target_key: &str,
    ) -> Result<Option<Self>, ApiError> {
        Ok(metadata
            .connection()?
            .query_row(
                &format!(
                    "{} WHERE workspace_id = ?1 AND target_key = ?2 ORDER BY rowid DESC LIMIT 1",
                    Self::SELECT
                ),
                [workspace, target_key],
                Self::from_row,
            )
            .optional()?)
    }

    fn insert(&self, metadata: &Metadata) -> Result<(), ApiError> {
        let count = metadata.connection()?.execute(
            "INSERT INTO backup_jobs (id, workspace_id, target_key, source_commit, prior_commit, planned_commit, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued') ON CONFLICT(id) DO NOTHING",
            params![self.view.id, self.view.workspace_id, self.target_key, self.view.source_commit_id, self.prior_commit, self.planned_commit],
        )?;
        if count == 0 {
            return Err(operation_reused());
        }
        Ok(())
    }

    fn finish(
        mut self,
        metadata: &Metadata,
        result: Result<(), &'static str>,
    ) -> Result<BackupJob, ApiError> {
        let status = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        };
        let message = result.err();
        metadata.connection()?.execute(
            "UPDATE backup_jobs SET status = ?2, message = ?3 WHERE id = ?1",
            params![self.view.id, status, message],
        )?;
        self.view.status = status.into();
        self.view.message = message.map(str::to_owned);
        self.view.commit_id = (status == "succeeded").then_some(self.planned_commit);
        Ok(self.view)
    }
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route(
            "/workspaces/{workspace}/backup",
            get(get_status).put(put_settings),
        )
        .route("/workspaces/{workspace}/backup/jobs", post(start_job))
        .route("/workspaces/{workspace}/backup/jobs/{job}", get(get_job))
}

fn view(metadata: &Metadata, workspace: &str, targets: Vec<Target>) -> Result<Status, ApiError> {
    let settings = Settings::load(metadata, workspace)?;
    let (target_id, last_job) = match settings.selected(&targets) {
        Ok(target) => (
            Some(target.id.clone()),
            Job::latest_for_target(metadata, workspace, &target.key()?)?.map(|job| job.view),
        ),
        Err(_) => (None, None),
    };
    Ok(Status {
        targets: targets.into_iter().map(Target::summary).collect(),
        target_needs_selection: settings.target_id.is_some() && target_id.is_none(),
        target_id,
        mode: settings.mode,
        last_job,
    })
}

async fn get_status(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Status>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        workspace::require_manage(&service, &account, &workspace)?;
        view(
            &service.metadata,
            &workspace,
            load_targets(&service.metadata, &workspace)?,
        )
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteSettings {
    #[serde(deserialize_with = "explicit_target")]
    target_id: Option<String>,
    mode: Mode,
}

fn explicit_target<'de, D: Deserializer<'de>>(value: D) -> Result<Option<String>, D::Error> {
    Option::deserialize(value)
}

async fn put_settings(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
    input: Result<Json<WriteSettings>, JsonRejection>,
) -> Result<Json<Status>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    run(move || {
        let db = &service.metadata;
        let _workspace = db.workspace_guard()?;
        workspace::require_manage(&service, &account, &workspace)?;
        let targets = load_targets(db, &workspace)?;
        let key = input.target_id.as_ref().map(|id| {
            targets.iter().find(|target| &target.id == id)
                .ok_or_else(|| ApiError::invalid("Choose a deployment backup target"))?.key()
        }).transpose()?;
        db.connection()?.execute(
            "INSERT INTO backup_settings (workspace_id, target_id, target_key, mode) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(workspace_id) DO UPDATE SET target_id = excluded.target_id, target_key = excluded.target_key, mode = excluded.mode",
            params![workspace, input.target_id, key, input.mode.as_str()],
        )?;
        view(db, &workspace, targets)
    }).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirm {
    operation_id: String,
}

async fn start_job(
    State(service): State<Arc<DocumentService>>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
    input: Result<Json<Confirm>, JsonRejection>,
) -> Result<(StatusCode, Json<BackupJob>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    let input = body(input)?;
    let operation = Uuid::parse_str(&input.operation_id)
        .ok()
        .filter(|id| id.to_string() == input.operation_id)
        .ok_or_else(|| ApiError::invalid("Expected a canonical operation UUID"))?;
    run(move || run_job(&service, &account, &headers, &workspace, operation))
        .await
        .map(|job| (StatusCode::ACCEPTED, Json(job)))
}

async fn get_job(
    State(service): State<Arc<DocumentService>>,
    Path((workspace, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<BackupJob>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        workspace::require_manage(&service, &account, &workspace)?;
        Job::load(&service.metadata, &id)?
            .filter(|job| job.view.workspace_id == workspace)
            .map(|job| job.view)
            .ok_or_else(ApiError::not_found)
    })
    .await
    .map(Json)
}

fn target_changed() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "backup_target_changed",
        "Confirm the current deployment backup target",
    )
}

fn operation_reused() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "operation_id_reused",
        "Operation ID belongs to another backup request",
    )
}

static RUNNING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

struct Running(PathBuf);

impl Running {
    fn acquire(key: PathBuf) -> Result<Self, ApiError> {
        let mut jobs = RUNNING
            .get_or_init(Mutex::default)
            .lock()
            .map_err(ApiError::internal)?;
        if !jobs.insert(key.clone()) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "backup_in_progress",
                "A backup is already in progress",
            ));
        }
        Ok(Self(key))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(Ok(mut jobs)) = RUNNING.get().map(Mutex::lock) {
            jobs.remove(&self.0);
        }
    }
}

fn run_job(
    service: &DocumentService,
    account: &Account,
    headers: &HeaderMap,
    workspace: &str,
    operation: Uuid,
) -> Result<BackupJob, ApiError> {
    let db = &service.metadata;
    let id = operation.to_string();
    let (job, target, source_root, backup_repo, _running) = {
        let _workspace = db.workspace_guard()?;
        let (instance, _) = workspace::require_manage(service, account, workspace)?;
        let existing = match Job::load(db, &id)? {
            Some(job) if job.view.workspace_id != workspace => return Err(operation_reused()),
            job => job,
        };
        let current = Settings::load(db, workspace)?;
        let targets = load_targets(db, workspace)?;
        let target = current.selected(&targets)?.clone();
        let key = target.key()?;
        let existing = match existing {
            Some(job) if job.target_key != key => return Err(target_changed()),
            Some(job) if job.view.status == "succeeded" => return Ok(job.view),
            job => job,
        };
        let running = match Running::acquire(db.product_file(REPOS_DIRECTORY).join(workspace)) {
            Ok(active) => active,
            Err(error) if error.code() == "backup_in_progress" => {
                return existing.map(|job| job.view).ok_or(error);
            }
            Err(error) => return Err(error),
        };
        let source = transport::source_repo(state(&instance)?)?;
        let backup_repo = transport::backup_repo(db, workspace, &key)?;
        let job = if let Some(job) = existing {
            job
        } else {
            let previous = Job::latest_for_target(db, workspace, &key)?;
            if previous
                .as_ref()
                .is_some_and(|job| job.view.status != "succeeded")
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "backup_retry_required",
                    "Retry the current backup before starting another",
                ));
            }
            let _read = product_read(state(&instance)?)?;
            let source_commit_id = transport::capture(&source, &backup_repo)?;
            let planned_commit = transport::plan(
                &backup_repo,
                &id,
                current.mode,
                &source_commit_id,
                previous.as_ref(),
            )?;
            let job = Job {
                view: BackupJob {
                    id,
                    workspace_id: workspace.to_owned(),
                    status: "queued".into(),
                    source_commit_id,
                    commit_id: None,
                    message: None,
                },
                target_key: key,
                prior_commit: previous.map(|job| job.planned_commit),
                planned_commit,
            };
            job.insert(db)?;
            job
        };
        (job, target, source, backup_repo, running)
    };
    let transport = match transport::Remote::new(&target, &source_root, &backup_repo) {
        Ok(transport) => transport,
        Err(error) => return job.finish(db, Err(error)),
    };
    let remote_head = transport.head();
    {
        let _workspace = db.workspace_guard()?;
        let active = Account::authenticate(&service.spaces, headers, true)?;
        workspace::require_manage(service, &active, workspace)?;
        let actual = load_targets(db, workspace)?;
        let selected = Settings::load(db, workspace)?;
        if selected.selected(&actual)?.key()? != job.target_key {
            return Err(target_changed());
        }
    }
    let latest = match remote_head {
        Ok(head) => head,
        Err(error) => return job.finish(db, Err(error)),
    };
    if latest.as_deref() == Some(&job.planned_commit) {
        return job.finish(db, Ok(()));
    }
    if latest != job.prior_commit {
        return job.finish(db, Err("The destination backup branch changed"));
    }
    let result = transport.push(&job.planned_commit, job.prior_commit.as_deref());
    job.finish(db, result)
}
