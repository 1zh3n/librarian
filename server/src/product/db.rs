use std::{
    io,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

use super::contract::ApiError;

pub(crate) const PRODUCT_DIR: &str = ".librarian";

pub(crate) struct Metadata(Mutex<Connection>);

impl Metadata {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
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
        let database = path.join("metadata.sqlite3");
        match std::fs::symlink_metadata(&database) {
            Ok(meta) if !meta.is_file() || meta.is_symlink() => {
                return Err("Invalid Librarian metadata database".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        Self::initialize(&database).map_err(|error| error.to_string())
    }

    fn initialize(path: &Path) -> rusqlite::Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
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
        } else if version != 1 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        transaction.commit()?;
        Ok(Self(Mutex::new(connection)))
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, ApiError> {
        self.0.lock().map_err(ApiError::internal)
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
}
