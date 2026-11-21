use std::{net::SocketAddr, path::Path, sync::Arc};

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Extension, Form, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use silverbullet_server::{
    auth::{
        cookie::set_cookie_value,
        is_secure_request,
        mcp::{
            cimd::CimdFetcher, clients::ClientRegistry, grants::GrantStore, wall_clock,
            McpOAuthState,
        },
        request_host, request_origin, scoped_auth_cookie_name, CodeStore, CookieOptions,
        LoginManager,
    },
    handlers::mcp_oauth::{self, SessionConsent},
    multi::{access::AnyUserAuth, users::UserStore},
    product::{
        mcp_bridge::McpBridge,
        password_limits::{client_address, PasswordLimits},
    },
};
use silverbullet_server_common::space::EmbeddedSpace;

use crate::assets::{reader_asset, ConsentAssets};
use silverbullet_server_mcp::{
    error_result, json_result, mcp_router_gated, Caller, CallerCredential, MultiHost, ToolDef,
    ToolResult, ToolSet,
};

const LOGIN_PATH: &str = "/.auth/librarian/login";
const CONSENT_STYLES_PATH: &str = "/.auth/librarian/consent.css";
const CONSENT_PATH: &str = "/.auth/mcp/authorize";
type McpEnabled = Arc<dyn Fn() -> bool + Send + Sync>;

pub fn build(root: &Path, bridge: McpBridge) -> Result<(Arc<MultiHost>, Router), String> {
    let spaces = bridge.spaces();
    let session = spaces.session;
    let password_limits = spaces.password_limits.clone();
    let clients = Arc::new(ClientRegistry::load(root).map_err(|err| err.to_string())?);
    let grants = Arc::new(GrantStore::load(root).map_err(|err| err.to_string())?);
    let host = Arc::new(
        MultiHost::new(spaces.manager.clone(), spaces.users.clone())
            .with_oauth(spaces.authenticator.clone(), grants.clone())
            .with_readable_consent()
            .with_login_path(LOGIN_PATH),
    );
    let users = spaces.users.clone();
    let credential_users = users.clone();
    let login = Arc::new(
        LoginManager::new(
            spaces.authenticator.clone(),
            Arc::new(AnyUserAuth {
                store: spaces.users.clone(),
            }),
            session.session_idle_secs,
            session.lockout(),
            String::new(),
        )
        .with_credential_version(Arc::new(move |username| {
            credential_users
                .credential_version(username)
                .unwrap_or_default()
        })),
    );

    let oauth = Arc::new(McpOAuthState {
        authenticator: spaces.authenticator.clone(),
        accounts: host.clone(),
        clients,
        cimd: Arc::new(CimdFetcher::new()),
        grants,
        codes: CodeStore::new(),
        consent: Arc::new(SessionConsent {
            csrf: login.clone(),
            bundle: Box::new(EmbeddedSpace::<ConsentAssets>::new()),
        }),
        now: wall_clock(),
    });

    let manager = spaces.manager.clone();
    let enabled: McpEnabled = Arc::new(move || {
        manager.mcp_enabled() && !matches!(std::env::var("SB_MCP").as_deref(), Ok("0" | "false"))
    });
    let tools = Arc::new(ProductTools(bridge));
    let login_router = Router::new()
        .route(CONSENT_STYLES_PATH, get(consent_styles))
        .route(
            LOGIN_PATH,
            get(login_page)
                .post(login_submit)
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .with_state(LoginState {
            manager: login,
            mcp_enabled: enabled.clone(),
            users,
            password_limits,
            trust_loopback_proxy: std::env::var("LIBRARIAN_TRUST_LOOPBACK_PROXY").as_deref()
                == Ok("1"),
        });
    let router = mcp_router_gated(tools, host.clone(), enabled.clone())
        .merge(mcp_oauth::router(oauth, enabled))
        .merge(login_router);
    Ok((host, router))
}

async fn consent_styles() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        concat!(
            include_str!("../../../apps/reader/src/styles/tokens.css"),
            "\n",
            include_str!("../../../apps/reader/src/login/Login.module.css"),
            "\n",
            include_str!("auth-assets/.client/authorize.css"),
        ),
    )
        .into_response()
}

struct ProductTools(McpBridge);

fn tool(
    name: &'static str,
    title: &'static str,
    description: &str,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> ToolDef {
    ToolDef {
        name,
        title,
        description: description.into(),
        input_schema: json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        }),
        annotations: json!({
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        }),
    }
}

#[async_trait::async_trait]
impl ToolSet for ProductTools {
    fn tools(&self) -> Vec<ToolDef> {
        let workspace = json!({"type": "string", "description": "Stable workspace ID returned by workspace_list."});
        let document = json!({"type": "string", "description": "Stable document ID returned by document_list, document_search, or document_create."});
        let commit = json!({"type": "string", "pattern": "^[0-9A-Fa-f]{40}$", "description": "Git commit ID from revision_list."});
        let operation = json!({"type": "string", "format": "uuid", "description": "Canonical operation UUID. Reuse it for an identical retry."});
        let revision = json!({"type": "string", "pattern": "^[0-9a-f]{64}$", "description": "SHA-256 content revision from document_read."});
        let markdown = json!({"type": "string", "description": "Complete original Markdown, with line endings preserved."});
        vec![
            tool(
                "workspace_list", "List workspaces", "List the workspaces accessible under the current grant.",
                json!({}), &[], true,
            ),
            tool(
                "workspace_publish", "Deliver documents", "Import documents and attachments into a granted Workspace. Identical content and manifest reuse the same receipt.",
                json!({"workspaceId": workspace, "delivery": {
                    "type": "object", "additionalProperties": false, "required": ["manifest"],
                    "properties": {
                        "manifest": {"type": "object", "additionalProperties": false, "required": ["deliveryId", "sourceName"],
                            "properties": {
                                "deliveryId": {"type": "string", "description": "Stable lowercase delivery name."},
                                "sourceName": {"type": "string"},
                                "version": {"type": "string"},
                                "generatedAt": {"type": "string", "format": "date-time"}
                            }
                        },
                        "files": {"type": "array", "items": {"type": "object", "required": ["path", "contentBase64"],
                            "additionalProperties": false, "properties": {"path": {"type": "string"}, "contentBase64": {"type": "string"}}}},
                        "archiveBase64": {"type": "string"}
                    },
                    "oneOf": [{"required": ["files"]}, {"required": ["archiveBase64"]}]
                }}),
                &["workspaceId", "delivery"], false,
            ),
            tool(
                "publication_request", "Request Zola publication", "Prepare an explicit publication request for a fixed revision and configured target. A Librarian Workspace manager confirms it separately.",
                json!({"workspaceId": workspace, "targetId": {"type": "string", "description": "Configured Zola target ID."}, "commitId": commit,
                    "documentIds": {"type": "array", "minItems": 1, "uniqueItems": true, "items": document}, "operationId": operation}),
                &["workspaceId", "targetId", "commitId", "documentIds", "operationId"], false,
            ),
            tool(
                "document_list", "List documents", "List documents in a granted workspace in path order.",
                json!({"workspaceId": workspace, "after": {"type": "string", "description": "List paths strictly after this document path."}, "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100}}),
                &["workspaceId"], true,
            ),
            tool(
                "document_read", "Read document", "Read the current original Markdown and its content revision.",
                json!({"documentId": document}), &["documentId"], true,
            ),
            tool(
                "document_search", "Search documents", "Search current documents in the specified granted workspace.",
                json!({"workspaceId": workspace, "query": {"type": "string", "minLength": 1, "maxLength": 256}}),
                &["workspaceId", "query"], true,
            ),
            tool(
                "document_create", "Create document", "Create a new Markdown document with an immediate Git revision. The path must be unused.",
                json!({"workspaceId": workspace, "operationId": operation, "path": {"type": "string", "description": "Relative document path ending in .md."}, "markdown": markdown}),
                &["workspaceId", "operationId", "path", "markdown"], false,
            ),
            tool(
                "document_update", "Update document", "Replace a document conditionally on its current content revision and create a Git revision.",
                json!({"documentId": document, "operationId": operation, "baseRevision": revision, "markdown": markdown}),
                &["documentId", "operationId", "baseRevision", "markdown"], false,
            ),
            tool(
                "document_outline_read", "Read document outline", "Read the independent outline Markdown and its content revision. The revision is null when the outline is absent.",
                json!({"documentId": document}), &["documentId"], true,
            ),
            tool(
                "document_outline_update", "Update document outline", "Write the independent outline conditionally and create a Git revision.",
                json!({"documentId": document, "operationId": operation,
                    "baseRevision": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$", "description": "Content revision from document_outline_read, or null to create the outline."}, "markdown": markdown}),
                &["documentId", "operationId", "baseRevision", "markdown"], false,
            ),
            tool(
                "revision_list", "List document revisions", "List the Git revisions that changed this document.",
                json!({"documentId": document, "before": commit, "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}}),
                &["documentId"], true,
            ),
            tool(
                "revision_diff", "Read document revision diff", "Read what a Git revision changed in this document and the original Markdown at that revision.",
                json!({"documentId": document, "commitId": commit}), &["documentId", "commitId"], true,
            ),
            tool(
                "revision_restore", "Restore document revision", "Restore historical Markdown if the current content revision matches. This creates a new Git revision.",
                json!({"documentId": document, "operationId": operation, "baseRevision": revision, "commitId": commit}),
                &["documentId", "operationId", "baseRevision", "commitId"], false,
            ),
        ]
    }

    fn instructions(&self) -> String {
        "Use workspace_list and document_list to discover stable Librarian IDs. Read the current content revision before an update or restore, and reuse an operation ID only for an identical retry.".into()
    }

    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").into()
    }

    async fn call(&self, caller: &Caller, name: &str, args: Value) -> ToolResult {
        let CallerCredential::Grant {
            spaces,
            credential_version,
            ..
        } = &caller.credential
        else {
            return error_result("A current OAuth grant is required");
        };
        match self
            .0
            .call(
                &caller.username,
                spaces,
                credential_version.as_deref(),
                name,
                args,
            )
            .await
        {
            Ok(result) => json_result(result),
            Err(error) => {
                let mut result = json_result(error);
                result["isError"] = json!(true);
                result
            }
        }
    }
}

#[derive(Deserialize)]
struct LoginQuery {
    next: Option<String>,
}

#[derive(Clone)]
struct LoginState {
    manager: Arc<LoginManager>,
    mcp_enabled: McpEnabled,
    users: Arc<UserStore>,
    password_limits: Arc<PasswordLimits>,
    trust_loopback_proxy: bool,
}

impl LoginQuery {
    fn target(&self, mcp_enabled: &dyn Fn() -> bool) -> Option<&str> {
        let next = self.next.as_deref().unwrap_or("/");
        let target = next.parse::<Uri>().ok()?;
        if target.scheme().is_some() || target.authority().is_some() {
            return None;
        }
        if target.path() == CONSENT_PATH {
            return mcp_enabled().then_some(next);
        }
        let segments: Vec<_> = target.path().split('/').collect();
        let id = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        };
        let known_route = match segments.as_slice() {
            ["", ""] | ["", "accounts"] => true,
            ["", "workspaces", workspace] => id(workspace),
            ["", "workspaces", workspace, "ai"] => id(workspace),
            ["", "workspaces", workspace, "manage"] => id(workspace),
            ["", "workspaces", workspace, "documents", document] => id(workspace) && id(document),
            ["", "r", snapshot] => id(snapshot),
            _ => false,
        };
        known_route.then_some(next)
    }
}

async fn login_page(State(login): State<LoginState>, Query(query): Query<LoginQuery>) -> Response {
    if query.target(&*login.mcp_enabled).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    sign_in_page(StatusCode::OK, "")
}

fn sign_in_page(status: StatusCode, username: &str) -> Response {
    let Some(page) = reader_asset("login.html") else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Ok(document) = std::str::from_utf8(&page.bytes) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let state = match status {
        StatusCode::OK => "ready",
        StatusCode::UNAUTHORIZED => "incorrect",
        StatusCode::TOO_MANY_REQUESTS => "limited",
        _ => "unavailable",
    };
    let username = username
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let document = document
        .replacen("librarian-login-ready", state, 1)
        .replacen(
            r#"data-username="""#,
            &format!(r#"data-username="{username}""#),
            1,
        );
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "strict-origin"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; script-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            ),
        ],
        Html(document),
    )
        .into_response()
}

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

async fn login_submit(
    State(login): State<LoginState>,
    Query(query): Query<LoginQuery>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Form(credentials): Form<Credentials>,
) -> Response {
    let Some(target) = query.target(&*login.mcp_enabled) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let origin = request_origin(&headers);
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(origin.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let source = client_address(
        peer.map(|Extension(ConnectInfo(peer))| peer.ip()),
        login.trust_loopback_proxy,
        headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok()),
    );
    let Some(attempt) = login
        .password_limits
        .reserve_login(&credentials.username, source)
        .await
    else {
        return sign_in_page(StatusCode::TOO_MANY_REQUESTS, &credentials.username);
    };

    let submitted_username = credentials.username.clone();
    let verifier = login.manager.clone();
    let users = login.users.clone();
    let token = tokio::task::spawn_blocking(move || {
        let version = users.credential_version(&credentials.username);
        if !verifier.authorize(&credentials.username, &credentials.password) || version.is_none() {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let jwt = verifier
            .issue_session(&credentials.username, false)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if users.credential_version(&credentials.username) != version {
            let _ = verifier.revoke_browser_session(&jwt);
            return Err(StatusCode::UNAUTHORIZED);
        }
        attempt.succeeded();
        Ok(jwt)
    })
    .await;
    let token = match token {
        Ok(Ok(token)) => token,
        Ok(Err(status)) => return sign_in_page(status, &submitted_username),
        Err(_) => return sign_in_page(StatusCode::INTERNAL_SERVER_ERROR, &submitted_username),
    };

    let options = CookieOptions {
        path: "/".into(),
        max_age_secs: login
            .manager
            .cookie_max_age(&token)
            .and_then(|age| i64::try_from(age).ok()),
        http_only: true,
        secure: is_secure_request(&headers),
        same_site: "Lax",
    };
    let cookie = set_cookie_value(
        &scoped_auth_cookie_name(&request_host(&headers), ""),
        &token,
        &options,
    );
    let Ok(cookie) = HeaderValue::from_str(&cookie) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut response = Redirect::to(target).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
