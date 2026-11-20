//! The multi-user side of search; the rule itself is `SpaceSearch`'s
//! (`crate::search::policy`). Here: how `server.json` and `spaces.json`
//! boot it ([`boot`]), an instance's engine ([`open`]), which spaces a
//! model change rebuilds
//! ([`model_change_rebuilds`]), and the page count each instance is judged
//! by ([`SpaceInstance::pages`]).

use std::path::Path;
use std::sync::{Arc, RwLockReadGuard};

use silverbullet_server_common::space::GitignoreMatcher;
use silverbullet_server_common::{FileMeta, SpaceError, SpacePrimitives};
use tokio::sync::broadcast;

use silverbullet_server_search::semantic::catalog::{self, ModelSpec};

use crate::multi::config::{MultiConfig, SpaceConfig};
use crate::multi::instance::{InstanceDeps, SpaceInstance};
use crate::multi::server_config::ServerConfig;
use crate::search::{
    folder_pages, SearchBackend, SemanticChoice, SemanticSpaceState, SpaceSearch, SpaceToOpen,
};
use crate::watcher::FsEvent;

/// Search workers share the product's mutation boundary with direct readers.
/// They index the final files after a batch is published or rolled back.
pub(super) struct TransactionalSearchSpace {
    pub inner: Arc<dyn SpacePrimitives>,
    pub guard: Arc<crate::fs_guard::FsGuard>,
}

impl TransactionalSearchSpace {
    fn read_guard(&self) -> Result<RwLockReadGuard<'_, ()>, SpaceError> {
        let lock = self.guard.mutation.read().map_err(|_| {
            SpaceError::Io(std::io::Error::other("Workspace storage lock was poisoned"))
        })?;
        if self.guard.storage_recovery_required() {
            return Err(SpaceError::Io(std::io::Error::other(
                "Workspace storage recovery is pending",
            )));
        }
        Ok(lock)
    }
}

impl SpacePrimitives for TransactionalSearchSpace {
    fn fetch_file_list(&self) -> Result<Vec<FileMeta>, SpaceError> {
        let _lock = self.read_guard()?;
        self.inner.fetch_file_list()
    }

    fn get_file_meta(&self, path: &str) -> Result<FileMeta, SpaceError> {
        let _lock = self.read_guard()?;
        self.inner.get_file_meta(path)
    }

    fn read_file(&self, path: &str) -> Result<(Vec<u8>, FileMeta), SpaceError> {
        let _lock = self.read_guard()?;
        self.inner.read_file(path)
    }

    fn write_file(&self, _: &str, _: &[u8], _: Option<&FileMeta>) -> Result<FileMeta, SpaceError> {
        Err(SpaceError::ReadOnly("Index storage is read-only".into()))
    }

    fn delete_file(&self, _: &str) -> Result<(), SpaceError> {
        Err(SpaceError::ReadOnly("Index storage is read-only".into()))
    }
}

/// `search` booted ([`SpaceSearch::boot`]) before any instance opens its
/// index and before the admin API can create a space: with `sweep`
/// (`spaces.json` exists), the indexes of spaces `spaces` doesn't have
/// (removed by hand, or a delete interrupted) go. Ids compare
/// case-insensitively: on a case-insensitive filesystem `Fern/` is the
/// directory of space `fern`. Semantic search starts with the model
/// `server.json` names.
pub(crate) fn boot(
    search: SpaceSearch,
    server: &ServerConfig,
    spaces: &MultiConfig,
    sweep: bool,
) -> SpaceSearch {
    let live = |id: &str| spaces.spaces.keys().any(|key| key.eq_ignore_ascii_case(id));
    let live: Option<&dyn Fn(&str) -> bool> = if sweep { Some(&live) } else { None };
    search.boot(boot_model(server, spaces), live)
}

/// The catalog model `server.json` names, if any. An unknown id warns and
/// leaves search full-text only.
fn boot_model(server: &ServerConfig, spaces: &MultiConfig) -> Option<&'static ModelSpec> {
    let spec = match catalog::resolve(server.search.model.as_deref()?) {
        Ok(spec) => spec,
        Err(unknown) => {
            tracing::warn!("server.json search.model {unknown}; search stays full-text only");
            return None;
        }
    };
    let opted_out = spaces
        .spaces
        .values()
        .filter(|s| s.semantic_search == SemanticChoice::Off)
        .count();
    tracing::info!("Search: {opted_out} spaces opted out of semantic search");
    Some(spec)
}

/// The engine of space `id` (`config`, in `folder`) on `deps.search`,
/// reading `space` with `ignore` and kept current by `events`
/// ([`SpaceSearch::open`]). A space that follows the default is counted
/// from its folder when that decides.
pub(crate) fn open(
    deps: &InstanceDeps,
    id: &str,
    config: &SpaceConfig,
    folder: &Path,
    space: Arc<dyn SpacePrimitives>,
    ignore: GitignoreMatcher,
    events: broadcast::Receiver<FsEvent>,
) -> Arc<dyn SearchBackend> {
    let space = SpaceToOpen {
        id,
        name: id,
        space,
        ignore,
        events,
        choice: config.semantic_search,
    };
    deps.search
        .open(space, || folder_pages(folder, &config.space_ignore))
}

/// Whether choosing a model (or none) must rebuild `existing` (`config`): it
/// runs semantic search now (its engine was opened with the service being
/// replaced), or it will. Its
/// page count stands in for counting its folder; unknown, it is rebuilt and
/// [`SpaceSearch::open`] decides.
pub(crate) fn model_change_rebuilds(
    search: &SpaceSearch,
    id: &str,
    config: &SpaceConfig,
    existing: &SpaceInstance,
) -> bool {
    let now = existing.search.is_some() && search.opened_state(id) == Some(SemanticSpaceState::On);
    now || search.semantic_state(id, config.semantic_search, || existing.pages())
        == SemanticSpaceState::On
}

impl SpaceInstance {
    /// The pages the space's full-text index counts right now, else the
    /// count its predecessor handed over (while a rebuilt instance's index
    /// reopens, or when it failed); `None` without either.
    pub(super) fn pages(&self) -> Option<u64> {
        self.search
            .as_ref()
            .and_then(|search| search.pages())
            .or(self.last_pages)
    }
}
