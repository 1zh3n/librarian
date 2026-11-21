use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

use super::contract::ApiError;

pub(crate) const PRODUCT_DIR: &str = ".librarian";

pub(crate) struct Metadata {
    directory: PathBuf,
    connection: Mutex<Connection>,
    ai_gate: Mutex<()>,
    workspace_gate: Mutex<()>,
}

pub(super) struct DataRootLock(fs::File);

impl Drop for DataRootLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

impl Metadata {
    pub(super) fn directory(root: &Path) -> Result<PathBuf, String> {
        let path = root.join(PRODUCT_DIR);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if !meta.is_dir() || meta.is_symlink() => {
                return Err("Invalid Librarian metadata directory".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&path).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        Ok(path)
    }

    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let directory = Self::directory(root)?;
        let database = directory.join("metadata.sqlite3");
        match std::fs::symlink_metadata(&database) {
            Ok(meta) if !meta.is_file() || meta.is_symlink() => {
                return Err("Invalid Librarian metadata database".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let connection = Self::initialize(&database).map_err(|error| error.to_string())?;
        Ok(Self {
            directory,
            connection: Mutex::new(connection),
            ai_gate: Mutex::new(()),
            workspace_gate: Mutex::new(()),
        })
    }

    pub(super) fn lock_root(root: &Path) -> Result<DataRootLock, String> {
        let lock = Self::directory(root)?.join("server.lock");
        match fs::symlink_metadata(&lock) {
            Ok(meta) if !meta.is_file() || meta.is_symlink() => {
                return Err("Invalid Librarian data lock".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock)
            .map_err(|error| error.to_string())?;
        file.try_lock()
            .map_err(|error| format!("Could not lock the Librarian data folder: {error}"))?;
        Ok(DataRootLock(file))
    }

    pub(super) fn operation_directory(&self, operation: &str) -> PathBuf {
        self.directory.join("mutations").join(operation)
    }

    pub(super) fn product_file(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }

    pub(super) fn retired_workspace_directory(&self) -> PathBuf {
        self.directory.join("retired-workspaces")
    }

    pub(super) fn ai_guard(&self) -> Result<MutexGuard<'_, ()>, ApiError> {
        self.ai_gate.lock().map_err(ApiError::internal)
    }

    pub(super) fn workspace_guard(&self) -> Result<MutexGuard<'_, ()>, ApiError> {
        self.workspace_gate.lock().map_err(ApiError::internal)
    }

    pub(super) fn runner_digest(&self) -> Result<Option<String>, ApiError> {
        let path = self.directory.join("runner-token.sha256");
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= 66 => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            _ => return Err(ApiError::internal("Invalid runner credential file")),
        }
        let digest = fs::read_to_string(path).map_err(ApiError::internal)?;
        let digest = digest.trim();
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ApiError::internal("Invalid runner credential digest"));
        }
        Ok(Some(digest.to_owned()))
    }

    fn initialize(path: &Path) -> rusqlite::Result<Connection> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;")?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let version: i64 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            transaction.execute_batch(
                "CREATE TABLE workspaces (
                   id TEXT PRIMARY KEY, space_id TEXT NOT NULL UNIQUE
                 );
                 CREATE TABLE documents (
                   id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                   path TEXT NOT NULL, UNIQUE(workspace_id, path)
                 );
                 PRAGMA user_version = 1;",
            )?;
        }
        if version <= 1 {
            transaction.execute_batch(
                "CREATE TABLE device_preferences (
                   account TEXT NOT NULL, device_id TEXT NOT NULL, settings TEXT NOT NULL,
                   PRIMARY KEY (account, device_id)
                 );
                 PRAGMA user_version = 2;",
            )?;
        }
        if version <= 2 {
            transaction.execute_batch(
                "CREATE TABLE mutations (
                   operation_id TEXT PRIMARY KEY,
                   workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                   account TEXT NOT NULL,
                   fingerprint TEXT NOT NULL,
                   state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'conflict')),
                   attempted INTEGER NOT NULL DEFAULT 0,
                   manifest TEXT NOT NULL
                 );
                 PRAGMA user_version = 3;",
            )?;
        }
        if version <= 3 {
            transaction.execute_batch(
                "CREATE TABLE ai_operations (
                   id TEXT PRIMARY KEY,
                   workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                   status TEXT NOT NULL,
                   lease_id TEXT UNIQUE,
                   expires_at INTEGER,
                   entry TEXT NOT NULL
                 );
                 CREATE INDEX ai_operations_queue ON ai_operations(status, expires_at);
                 CREATE TABLE ai_events (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   operation_id TEXT NOT NULL REFERENCES ai_operations(id),
                   kind TEXT NOT NULL,
                   payload TEXT NOT NULL
                 );
                 CREATE INDEX ai_events_cursor ON ai_events(operation_id, seq);
                 PRAGMA user_version = 4;",
            )?;
        }
        if version <= 4 {
            transaction.execute_batch(
                "ALTER TABLE ai_events ADD COLUMN lease_id TEXT;
                 ALTER TABLE ai_events ADD COLUMN executor_seq INTEGER;
                 CREATE UNIQUE INDEX ai_events_from_runner ON ai_events(operation_id, lease_id, executor_seq);
                 PRAGMA user_version = 5;",
            )?;
        }
        if version <= 5 {
            super::workspace::migrate(&transaction)?;
            super::delivery::migrate(&transaction)?;
            super::snapshots::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 6)?;
        }
        if version <= 6 {
            super::backup::migrate(&transaction)?;
            super::publication::migrate(&transaction)?;
            transaction.pragma_update(None, "user_version", 7)?;
        }
        if version <= 7 {
            super::delivery::migrate_scoped_tokens(&transaction)?;
            transaction.pragma_update(None, "user_version", 8)?;
        }
        if version <= 8 {
            transaction.pragma_update(None, "user_version", 9)?;
        } else if version != 9 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        super::ai_configuration::migrate(&transaction)?;
        super::ai_conversations::migrate(&transaction)?;
        super::ai_materials::migrate(&transaction)?;
        transaction.commit()?;
        Ok(connection)
    }

    pub(super) fn connection(&self) -> Result<MutexGuard<'_, Connection>, ApiError> {
        self.connection.lock().map_err(ApiError::internal)
    }

    pub(crate) fn workspace_id(&self, space_id: &str) -> Result<String, ApiError> {
        Ok(self.connection()?.query_row(
            "INSERT INTO workspaces (id, space_id) VALUES (?1, ?2)
             ON CONFLICT(space_id) DO UPDATE SET space_id = excluded.space_id RETURNING id",
            [
                format!("ws_{}", Uuid::new_v4().simple()),
                space_id.to_owned(),
            ],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn space_id(&self, workspace: &str) -> Result<String, ApiError> {
        self.connection()?
            .query_row(
                "SELECT space_id FROM workspaces WHERE id = ?1",
                [workspace],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(ApiError::not_found)
    }

    pub(crate) fn document_id(&self, workspace: &str, path: &str) -> Result<String, ApiError> {
        Ok(self.connection()?.query_row(
            "INSERT INTO documents (id, workspace_id, path) VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace_id, path) DO UPDATE SET path = excluded.path RETURNING id",
            [
                format!("doc_{}", Uuid::new_v4().simple()),
                workspace.to_owned(),
                path.to_owned(),
            ],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn document_path(&self, document: &str) -> Result<(String, String), ApiError> {
        self.connection()?
            .query_row(
                "SELECT workspace_id, path FROM documents WHERE id = ?1",
                [document],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(ApiError::not_found)
    }

    pub(super) fn device_preferences(
        &self,
        account: &str,
        device: &str,
    ) -> Result<Option<String>, ApiError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT settings FROM device_preferences WHERE account = ?1 AND device_id = ?2",
                [account, device],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub(super) fn set_device_preferences(
        &self,
        account: &str,
        device: &str,
        settings: &str,
    ) -> Result<(), ApiError> {
        self.connection()?.execute(
            "INSERT INTO device_preferences (account, device_id, settings) VALUES (?1, ?2, ?3)
             ON CONFLICT(account, device_id) DO UPDATE SET settings = excluded.settings",
            [account, device, settings],
        )?;
        Ok(())
    }
}
