use std::marker::PhantomData;

use rust_embed::RustEmbed;

use super::layer_perm;
use crate::{FileMeta, SpaceError, SpacePrimitives};

/// A read-only `SpacePrimitives` over a `rust-embed` asset set.
///
/// `PhantomData<fn() -> E>` keeps the marker unconditionally `Send + Sync`
/// (required by `SpacePrimitives`) without imposing those bounds on `E`.
pub struct EmbeddedSpace<E: RustEmbed> {
    _marker: PhantomData<fn() -> E>,
    copy_on_write: Vec<String>,
}

impl<E: RustEmbed> EmbeddedSpace<E> {
    pub fn new() -> Self {
        Self {
            _marker: PhantomData,
            copy_on_write: Vec::new(),
        }
    }

    /// Marks files under these path prefixes copy-on-write (see [`layer_perm`]).
    pub fn with_copy_on_write(mut self, prefixes: &[&str]) -> Self {
        self.copy_on_write = prefixes.iter().map(|p| p.to_string()).collect();
        self
    }

    fn meta_for(&self, path: &str, data_len: usize, last_modified: Option<u64>) -> FileMeta {
        // rust-embed reports seconds; FileMeta and the client sync hash use milliseconds.
        let ts = last_modified.unwrap_or(0) as i64 * 1000;
        FileMeta {
            name: path.to_string(),
            created: ts,
            last_modified: ts,
            content_type: mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string(),
            size: data_len as i64,
            perm: layer_perm(&self.copy_on_write, path),
        }
    }
}

impl<E: RustEmbed> Default for EmbeddedSpace<E> {
    fn default() -> Self {
        Self::new()
    }
}

impl<E: RustEmbed> SpacePrimitives for EmbeddedSpace<E> {
    fn fetch_file_list(&self) -> Result<Vec<FileMeta>, SpaceError> {
        Ok(E::iter()
            .filter_map(|p| self.get_file_meta(&p).ok())
            .collect())
    }

    fn get_file_meta(&self, path: &str) -> Result<FileMeta, SpaceError> {
        let f = E::get(path).ok_or(SpaceError::NotFound)?;
        Ok(self.meta_for(path, f.data.len(), f.metadata.last_modified()))
    }

    fn read_file(&self, path: &str) -> Result<(Vec<u8>, FileMeta), SpaceError> {
        let f = E::get(path).ok_or(SpaceError::NotFound)?;
        let meta = self.meta_for(path, f.data.len(), f.metadata.last_modified());
        Ok((f.data.into_owned(), meta))
    }

    fn write_file(
        &self,
        path: &str,
        _data: &[u8],
        _meta: Option<&FileMeta>,
    ) -> Result<FileMeta, SpaceError> {
        Err(SpaceError::WriteError(format!(
            "Cannot write {path}: embedded bundle is read-only"
        )))
    }

    fn delete_file(&self, path: &str) -> Result<(), SpaceError> {
        Err(SpaceError::WriteError(format!(
            "Cannot delete {path}: embedded bundle is read-only"
        )))
    }
}
