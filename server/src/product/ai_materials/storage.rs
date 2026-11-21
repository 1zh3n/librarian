use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Seek},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use rusqlite::{params, OptionalExtension};
use tempfile::NamedTempFile;
use tokio::sync::Semaphore;

use super::{
    super::{contract::ApiError, db::Metadata, documents::DocumentService},
    segment::{ParseResult, Segment},
};

pub(super) const DRAFT_TTL: i64 = 24 * 60 * 60;
pub(super) const BOUND_TTL: i64 = 7 * DRAFT_TTL;
static WORKERS: Semaphore = Semaphore::const_new(2);
const DEADLINE: Duration = Duration::from_secs(15);

pub(super) fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(super) fn directory(db: &Metadata) -> Result<PathBuf, ApiError> {
    let dir = db.product_file("ai-materials");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let m = fs::symlink_metadata(&dir).map_err(ApiError::internal)?;
            if !m.is_dir() || m.is_symlink() {
                return Err(ApiError::internal("Invalid material directory"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if m.permissions().mode() & 0o077 != 0 {
                    return Err(ApiError::internal("Material directory must be private"));
                }
            }
        }
        Err(e) => return Err(ApiError::internal(e)),
    }
    Ok(dir)
}

fn remove(dir: &Path, name: &str) -> io::Result<()> {
    match fs::remove_file(dir.join(name)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(in crate::product) fn unlink(db: &Metadata, id: &str) -> Result<(), ApiError> {
    let dir = directory(db)?;
    for suffix in ["raw", "json"] {
        remove(&dir, &format!("{id}.{suffix}")).map_err(ApiError::internal)?;
    }
    Ok(())
}

/// Hold the SQLite connection lock while publishing or sweeping file names.
/// Anonymous upload and parser-output files never appear in the sweep.
pub(in crate::product) fn sweep(
    service: &Arc<DocumentService>,
    startup: bool,
) -> Result<(), ApiError> {
    let db = &service.metadata;
    let dir = directory(db)?;
    {
        let con = db.connection()?;
        con.execute("DELETE FROM ai_materials WHERE expires_at<=?1", [now()])?;
        if startup {
            con.execute(
                "UPDATE ai_materials SET status='parsing' WHERE status='working'",
                [],
            )?;
        }
        let mut q = con.prepare("SELECT id, status FROM ai_materials")?;
        let mut known = HashSet::new();
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, status) = row?;
            known.insert(format!("{id}.raw"));
            known.insert(format!("{id}.json"));
            if startup && status != "failed" {
                if !dir.join(format!("{id}.raw")).is_file() {
                    con.execute("UPDATE ai_materials SET status='failed', error_code='interrupted' WHERE id=?1",[&id])?;
                } else if status == "ready" && !dir.join(format!("{id}.json")).is_file() {
                    con.execute(
                        "UPDATE ai_materials SET status='parsing' WHERE id=?1",
                        [&id],
                    )?;
                }
            }
        }
        for entry in fs::read_dir(&dir).map_err(ApiError::internal)? {
            let entry = entry.map_err(ApiError::internal)?;
            if !startup && entry.file_name().to_string_lossy().starts_with(".upload-") {
                continue;
            }
            if !known.contains(&entry.file_name().to_string_lossy().into_owned()) {
                fs::remove_file(entry.path()).map_err(ApiError::internal)?;
            }
        }
    }
    kick(service);
    Ok(())
}

pub(super) fn kick(service: &Arc<DocumentService>) {
    let pending = service.metadata.connection().and_then(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_materials WHERE status='parsing')",
            [],
            |row| row.get::<_, bool>(0),
        )?)
    });
    if !matches!(pending, Ok(true)) {
        return;
    }
    let weak = Arc::downgrade(service);
    tokio::spawn(async move {
        let Ok(permit) = WORKERS.acquire().await else {
            return;
        };
        let Some(service) = weak.upgrade() else {
            return;
        };
        let _ = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if let Err(err) = drain(&service.metadata) {
                tracing::warn!(?err, "Material parser queue will retry");
            }
        })
        .await;
    });
}

fn drain(db: &Metadata) -> Result<(), ApiError> {
    let dir = directory(db)?;
    loop {
        let job = db
            .connection()?
            .query_row(
                "UPDATE ai_materials SET status='working' WHERE id=(SELECT id FROM ai_materials
             WHERE status='parsing' AND expires_at>?1 ORDER BY rowid LIMIT 1) RETURNING id, format",
                [now()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((id, format)) = job else {
            return Ok(());
        };
        let parsed = parse_file(&dir, &id, &format);
        let con = db.connection()?;
        let live: bool = con.query_row("SELECT EXISTS(SELECT 1 FROM ai_materials WHERE id=?1 AND status='working' AND expires_at>?2)",params![id,now()],|r|r.get(0))?;
        if live {
            let result = parsed.and_then(|segments| {
                let tmp = NamedTempFile::new_in(&dir).map_err(|_| "storage_error")?;
                serde_json::to_writer(tmp.as_file(), &segments).map_err(|_| "storage_error")?;
                tmp.as_file().sync_all().map_err(|_| "storage_error")?;
                tmp.persist(dir.join(format!("{id}.json")))
                    .map_err(|_| "storage_error")?;
                Ok(())
            });
            match result {
                Ok(()) => con.execute(
                    "UPDATE ai_materials SET status='ready',error_code=NULL WHERE id=?1",
                    [id],
                )?,
                Err(code) => con.execute(
                    "UPDATE ai_materials SET status='failed', error_code=?2 WHERE id=?1",
                    params![id, code],
                )?,
            };
        }
    }
}

fn parse_file(dir: &Path, id: &str, format: &str) -> Result<Vec<Segment>, &'static str> {
    let mut exe = std::env::current_exe().map_err(|_| "parser_unavailable")?;
    // Cargo integration-test executables are in debug/deps beside debug/librarian.
    if let Some(target) = exe
        .parent()
        .filter(|p| p.ends_with("deps") || p.ends_with("examples"))
        .and_then(Path::parent)
    {
        exe = target.join(format!("librarian{}", std::env::consts::EXE_SUFFIX));
    }
    let input = File::open(dir.join(format!("{id}.raw"))).map_err(|_| "interrupted")?;
    let mut output = tempfile::tempfile_in(dir).map_err(|_| "storage_error")?;
    let mut cmd = Command::new(exe);
    cmd.args(["material-parser", format])
        .env_clear()
        .current_dir(dir)
        .stdin(input)
        .stdout(output.try_clone().map_err(|_| "storage_error")?)
        .stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe setrlimit is called between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                for (resource, max) in [
                    (libc::RLIMIT_AS, 512 * 1024 * 1024),
                    (libc::RLIMIT_FSIZE, 8 * 1024 * 1024),
                    (libc::RLIMIT_CORE, 0),
                ] {
                    let limit = libc::rlimit {
                        rlim_cur: max,
                        rlim_max: max,
                    };
                    if libc::setrlimit(resource, &limit) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }
    let child = cmd.spawn().map_err(|_| "parser_unavailable")?;
    wait(child, DEADLINE)?;
    if output.metadata().map_err(|_| "storage_error")?.len() > 8 * 1024 * 1024 {
        return Err("extraction_limit");
    }
    output.rewind().map_err(|_| "storage_error")?;
    match serde_json::from_reader(output).map_err(|_| "invalid_file")? {
        ParseResult::Ready { segments } => Ok(segments),
        ParseResult::Failed { error_code } => Err(match error_code.as_str() {
            "type_mismatch" => "type_mismatch",
            "no_text" => "no_text",
            "encrypted_pdf" => "encrypted_pdf",
            "extraction_limit" => "extraction_limit",
            "expansion_limit" => "expansion_limit",
            _ => "invalid_file",
        }),
    }
}

fn wait(mut child: Child, timeout: Duration) -> Result<(), &'static str> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("invalid_file")
                }
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("parse_timeout");
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn overdue_child_is_killed_and_reaped() {
        let child = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let id = child.id();
        assert_eq!(wait(child, Duration::from_millis(40)), Err("parse_timeout"));
        #[cfg(target_os = "linux")]
        assert!(!Path::new(&format!("/proc/{id}")).exists());
    }
}
