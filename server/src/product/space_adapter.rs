use std::sync::{atomic::AtomicBool, atomic::AtomicU64, Arc};
use std::{fs, io, path::Path};

use silverbullet_server_common::space::EmptySpacePrimitives;
use silverbullet_server_common::SpacePrimitives;

use crate::auth::{Authenticator, BrowserSessions, MULTI_AUTH_FILE_NAME};
use crate::multi::access::SessionPolicy;
use crate::multi::config::MemberRole;
use crate::multi::instance::{AssetFactories, InstanceAuth, InstanceDeps, RuntimeRequest};
use crate::multi::manager::MultiManager;
use crate::multi::setup::first_admin;
use crate::multi::users::{Profile, UserStore, USERS_FILE};
use crate::runtime::RuntimeAvailability;
use crate::search::{search_root, SpaceSearch};

pub fn initialize_data_root(root: &Path, username: &str, password: &str) -> Result<(), String> {
    if !super::password_limits::valid_password(password) {
        return Err(super::password_limits::PASSWORD_REQUIREMENTS.into());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root).map_err(|error| error.to_string())?;
    let _data_lock = super::db::Metadata::lock_root(root)?;
    let users = root.join(USERS_FILE);
    match fs::symlink_metadata(&users) {
        Ok(_) => return Err("Librarian accounts already exist in this data folder".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let config = first_admin(username, password, Profile::default()).map_err(|errors| {
        errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join(", ")
    })?;
    config.save(&users)
}

pub struct BootstrapAdminInvite {
    pub token: String,
    pub url: String,
    pub expires_at: i64,
}

/// Create a one-time administrator invitation. With `require_empty`, this is
/// the first-account bootstrap path; otherwise it is a root-only recovery path
/// for an existing data folder.
pub fn create_admin_invite(
    root: &Path,
    username: &str,
    public_url: Option<&str>,
    expires_in_secs: i64,
    require_empty: bool,
) -> Result<BootstrapAdminInvite, String> {
    let username = username.trim();
    if username.is_empty()
        || username.len() > 64
        || !username
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("Use a username of 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit".into());
    }
    let raw_url = public_url.unwrap_or("http://127.0.0.1:8080");
    let url = reqwest::Url::parse(raw_url).map_err(|_| "public URL must be an absolute URL")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "public URL must be the HTTPS origin (or localhost) without a path, query or fragment"
                .into(),
        );
    }
    let origin = url.origin().ascii_serialization();
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root).map_err(|error| error.to_string())?;
    let _data_lock = super::db::Metadata::lock_root(root)?;
    let users_path = root.join(USERS_FILE);
    if require_empty {
        match fs::symlink_metadata(&users_path) {
            Ok(_) => return Err("Librarian accounts already exist in this data folder".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if let Some(users) = UserStore::open(root)? {
        if users.user_exists(username) {
            return Err("The username is already in use".into());
        }
    } else if !require_empty {
        return Err("Librarian accounts are not initialized in this data folder".into());
    }
    let metadata = super::db::Metadata::open(root)?;
    let now = chrono::Utc::now().timestamp();
    let expires_at = now + expires_in_secs.clamp(60, 24 * 3600);
    let (token, invite) = super::invites::create(
        &metadata,
        super::invites::NewInvite {
            username: username.to_owned(),
            admin: true,
            role: MemberRole::Write,
            workspace_ids: Vec::new(),
            created_by: "cli".into(),
            expires_at,
        },
    )
    .map_err(|error| format!("{error:?}"))?;
    if require_empty {
        UserStore::create_empty(root)?;
    }
    Ok(BootstrapAdminInvite {
        url: format!("{origin}/.auth/librarian/invite?token={token}"),
        token,
        expires_at: invite.expires_at,
    })
}

pub struct NativeSpaces {
    pub grants: Arc<crate::auth::mcp::grants::GrantStore>,
    pub manager: Arc<MultiManager>,
    pub users: Arc<UserStore>,
    pub authenticator: Arc<Authenticator>,
    pub session: SessionPolicy,
    pub password_limits: Arc<super::password_limits::PasswordLimits>,
    _data_lock: super::db::DataRootLock,
}

impl NativeSpaces {
    pub fn open(root: &Path, port: u16, version: &str) -> Result<Self, String> {
        let data_lock = super::db::Metadata::lock_root(root)?;
        let metadata = super::db::Metadata::open(root)?;
        super::mutations::recover_startup(root, &metadata)?;
        super::workspace::recover_startup(&metadata)?;
        super::delivery::recover_startup(&metadata).map_err(|error| format!("{error:?}"))?;
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
        let password_limits = super::password_limits::PasswordLimits::new(
            session.lockout_time_secs,
            session.lockout_limit,
        );
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
            grants: Arc::new(
                crate::auth::mcp::grants::GrantStore::load(root).map_err(|e| e.to_string())?,
            ),
            manager,
            users,
            authenticator,
            session,
            password_limits,
        })
    }
}
