use std::path::Path;
use std::sync::{atomic::AtomicBool, atomic::AtomicU64, Arc};

use silverbullet_server_common::space::EmptySpacePrimitives;
use silverbullet_server_common::SpacePrimitives;

use crate::auth::{Authenticator, BrowserSessions, MULTI_AUTH_FILE_NAME};
use crate::multi::access::SessionPolicy;
use crate::multi::instance::{AssetFactories, InstanceAuth, InstanceDeps, RuntimeRequest};
use crate::multi::manager::MultiManager;
use crate::multi::users::UserStore;
use crate::runtime::RuntimeAvailability;
use crate::search::{search_root, SpaceSearch};

pub struct NativeSpaces {
    pub manager: Arc<MultiManager>,
    pub users: Arc<UserStore>,
    pub authenticator: Arc<Authenticator>,
    pub session: SessionPolicy,
    _data_lock: super::db::DataRootLock,
}

impl NativeSpaces {
    pub fn open(root: &Path, port: u16, version: &str) -> Result<Self, String> {
        let data_lock = super::db::Metadata::lock_root(root)?;
        let metadata = super::db::Metadata::open(root)?;
        super::mutations::recover_startup(root, &metadata)?;
        let users = UserStore::open(root)?
            .ok_or_else(|| "Missing users.json in the Librarian data folder".to_string())?;
        let authenticator = Arc::new(
            Authenticator::load_or_init_with_stamp_named(
                root,
                "account-managed-session-v1",
                MULTI_AUTH_FILE_NAME,
            )
            .map_err(|err| format!("Could not open account credentials: {err}"))?
            .with_browser_sessions(Arc::new(
                BrowserSessions::load(root).map_err(|err| err.to_string())?,
            )),
        );
        let session = SessionPolicy::from_env();
        let empty = || Box::new(EmptySpacePrimitives) as Box<dyn SpacePrimitives>;
        let deps = InstanceDeps {
            root: Some(root.to_owned()),
            assets: AssetFactories {
                client_bundle: Box::new(empty),
                base_fs: Box::new(empty),
            },
            runtime: Arc::new(|_: &RuntimeRequest<'_>| None),
            runtime_enabled: Arc::new(AtomicBool::new(false)),
            runtime_availability: RuntimeAvailability::NoChrome,
            runtime_idle_timeout: Arc::new(AtomicU64::new(0)),
            metrics: None,
            auth: InstanceAuth::Accounts {
                users: users.clone(),
                authenticator: authenticator.clone(),
                session,
            },
            version: version.into(),
            main_port: port,
            disable_service_worker: true,
            shell_disabled: true,
            exact_markdown_revisions: true,
            shutdown: None,
            search: SpaceSearch::in_root(search_root(root)),
        };
        let manager = MultiManager::boot(root.to_owned(), deps, users.usernames())?;
        Ok(Self {
            _data_lock: data_lock,
            manager,
            users,
            authenticator,
            session,
        })
    }
}
