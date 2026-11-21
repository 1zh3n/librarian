//! An undo reconnects two known periods of the same document's life. Git
//! still follows renames and stops at additions and copies within each period.
use crate::product::{contract::ApiError, db::Metadata, snapshots::git_blobs};
use crate::revisions::{read, FileRevisions, RevisionStore};

pub(in crate::product) struct Lineage<'a> {
    store: &'a RevisionStore,
    segments: Vec<Segment>,
}

struct Segment {
    head: String,
    path: String,
}

impl<'a> Lineage<'a> {
    pub(in crate::product) fn load(
        metadata: &Metadata,
        store: &'a RevisionStore,
        workspace: &str,
        id: &str,
        path: &str,
    ) -> Result<Self, ApiError> {
        let bridges = {
            let connection = metadata.connection()?;
            let mut query = connection.prepare(
                "SELECT restore_commit, deletion_commit, path, COALESCE(restore_path,path) FROM restored_document_history
                WHERE workspace=? AND document=? ORDER BY rowid DESC",
            )?;
            let rows = query
                .query_map([workspace, id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut segments = vec![Segment {
            head: "HEAD".into(),
            path: path.into(),
        }];
        for (restore, deletion, old_path, restored_path) in bridges {
            let latest = segments.last().expect("current history segment");
            // A move out and back into this space starts a new local history.
            if latest.path_at(store, &restore)?.as_deref() != Some(&restored_path) {
                continue;
            }
            let repo = store.repo_root().ok_or_else(ApiError::not_found)?;
            let head = git_blobs::resolve_commit(&repo, &format!("{deletion}^"))?;
            segments.push(Segment {
                head,
                path: old_path,
            });
        }
        Ok(Self { store, segments })
    }

    pub(in crate::product) fn path_at(&self, commit: &str) -> Result<Option<String>, ApiError> {
        for segment in &self.segments {
            if let Some(path) = segment.path_at(self.store, commit)? {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }

    pub(super) fn page(
        &self,
        before: Option<&str>,
        limit: usize,
    ) -> Result<FileRevisions, ApiError> {
        // The current page also supplies the live worktree status for every cursor.
        let mut first = read::file_history(self.store, &self.segments[0].path, before, limit)
            .map_err(ApiError::internal)?;
        if self.segments.len() == 1 || first.more {
            return Ok(first);
        }
        let mut cursor = before;
        if let Some(commit) = cursor {
            if self.segments[0].path_at(self.store, commit)?.is_some() {
                cursor = None;
            }
        }
        for segment in self.segments.iter().skip(1) {
            if let Some(commit) = cursor {
                if segment.path_at(self.store, commit)?.is_none() {
                    continue;
                }
            }
            let available = limit - first.revisions.len();
            let next = read::file_history_from(
                self.store,
                &segment.path,
                &segment.head,
                cursor,
                available + 1,
            )
            .map_err(ApiError::internal)?;
            cursor = None;
            first.revisions.extend(next.revisions);
            if first.revisions.len() > limit {
                first.revisions.truncate(limit);
                first.more = true;
                break;
            }
        }
        Ok(first)
    }
}

impl Segment {
    fn path_at(&self, store: &RevisionStore, commit: &str) -> Result<Option<String>, ApiError> {
        read::file_path_at_revision_from(store, &self.path, &self.head, commit)
            .map_err(ApiError::internal)
    }
}
