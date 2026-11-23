use std::{net::SocketAddr, path::Path, sync::Arc};

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Extension, Form, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use silverbullet_server::{
    auth::{
        cookie::{cookie_value, set_cookie_value},
        is_secure_request,
        mcp::{cimd::CimdFetcher, clients::ClientRegistry, wall_clock, McpOAuthState},
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
const TOTP_PATH: &str = "/.auth/librarian/totp";
const INVITE_PATH: &str = "/.auth/librarian/invite";
const CONSENT_STYLES_PATH: &str = "/.auth/librarian/consent.css";
const CONSENT_PATH: &str = "/.auth/mcp/authorize";
type McpEnabled = Arc<dyn Fn() -> bool + Send + Sync>;

pub fn build(root: &Path, bridge: McpBridge) -> Result<(Arc<MultiHost>, Router), String> {
    let spaces = bridge.spaces();
    let session = spaces.session;
    let password_limits = spaces.password_limits.clone();
    let clients = Arc::new(ClientRegistry::load(root).map_err(|err| err.to_string())?);
    let grants = spaces.grants.clone();
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
        .route(
            TOTP_PATH,
            get(totp_page_handler)
                .post(totp_submit)
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(INVITE_PATH, get(invite_page))
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
    destructive: bool,
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
            "destructiveHint": destructive,
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
                json!({}), &[], true, false,
            ),
            tool("workspace_upload_files","Upload files","Write a file group into a directory. Existing files require an explicit revision.",
                json!({"workspaceId":workspace,"operationId":operation,"targetDirectory":{"type":"string"},
                 "files":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","required":["path","contentBase64"],"additionalProperties":false,"properties":{"path":{"type":"string"},"contentBase64":{"type":"string","contentEncoding":"base64"}}}},
                 "updates":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["path","baseRevision"],"properties":{"path":{"type":"string"},"baseRevision":revision}}}}),
                &["workspaceId","targetDirectory","operationId","files"],false,true),
            tool("workspace_apply_edits","Apply document edits","Commit a conditional Markdown batch in one version.",
                json!({"workspaceId":workspace,"operationId":operation,"edits":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,
                    "oneOf":[{"required":["path"]},{"required":["documentId"]}],"required":["baseRevision","markdown"],"properties":{"path":{"type":"string"},"documentId":document,"baseRevision":{"type":["string","null"]},"markdown":markdown}}}}),
                &["workspaceId","operationId","edits"],false,true),
            tool("workspace_request_reorganization","Request move or deletion","Preview the change for confirmation in Reader.",
                json!({"workspaceId":workspace,"operationId":operation,"request":{"oneOf":[
                    {"type":"object","additionalProperties":false,"required":["kind","from","to"],"properties":{"kind":{"const":"move"},"from":{"type":"string"},"to":{"type":"string"}}},
                    {"type":"object","additionalProperties":false,"required":["kind","documentIds"],"properties":{"kind":{"const":"delete"},"documentIds":{"type":"array","items":document}}}]}}),
                &["workspaceId","operationId","request"],false,false),
            tool("workspace_get_operation","Get operation","Read a receipt under the original grant.",
                json!({"workspaceId":workspace,"operationId":operation}),&["workspaceId","operationId"],true,false),
            tool("workspace_undo_operation","Undo operation","Conditionally reverse the committed operation under its original grant.",
                json!({"workspaceId":workspace,"operationId":operation}),&["workspaceId","operationId"],false,true),
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
                &["workspaceId", "delivery"], false, true,
            ),
            tool(
                "publication_request", "Request Zola publication", "Prepare an explicit publication request for a fixed revision and configured target. A Librarian Workspace manager confirms it separately.",
                json!({"workspaceId": workspace, "targetId": {"type": "string", "description": "Configured Zola target ID."}, "commitId": commit,
                    "documentIds": {"type": "array", "minItems": 1, "uniqueItems": true, "items": document}, "operationId": operation}),
                &["workspaceId", "targetId", "commitId", "documentIds", "operationId"], false, false,
            ),
            tool(
                "workspace_upload_image", "Upload image", "Upload one PNG, JPEG, WebP, GIF or AVIF image into a granted Workspace. The server chooses a non-conflicting name by default and returns an asset URL.",
                json!({"workspaceId": workspace, "operationId": operation, "targetDirectory": {"type": "string", "description": "Safe relative directory; empty means the workspace root."}, "fileName": {"type": "string", "description": "Single file name with a supported image extension."}, "contentBase64": {"type": "string", "contentEncoding": "base64"}, "conflictPolicy": {"type": "string", "enum": ["rename", "reject"], "default": "rename"}, "baseRevision": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$", "description": "Set only when replacing an existing image."}}),
                &["workspaceId", "operationId", "targetDirectory", "fileName", "contentBase64"], false, true,
            ),
            tool(
                "workspace_read_asset", "Read asset", "Read an image or attachment from a granted Workspace. Images up to 8 MiB are returned as MCP image content; larger assets return metadata and a URL.",
                json!({"workspaceId": workspace, "path": {"type": "string", "description": "Safe relative workspace asset path."}}),
                &["workspaceId", "path"], true, false,
            ),
            tool(
                "workspace_list_assets", "List assets", "List non-Markdown assets in a granted workspace, including images, in path order.",
                json!({"workspaceId": workspace, "directory": {"type": "string", "description": "Optional safe relative directory prefix."}, "after": {"type": "string", "description": "List paths strictly after this path."}, "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100}}),
                &["workspaceId"], true, false,
            ),
            tool(
                "document_list", "List documents", "List documents in a granted workspace in path order.",
                json!({"workspaceId": workspace, "after": {"type": "string", "description": "List paths strictly after this document path."}, "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100}}),
                &["workspaceId"], true, false,
            ),
            tool(
                "document_read", "Read document", "Read the current original Markdown and its content revision.",
                json!({"documentId": document}), &["documentId"], true, false,
            ),
            tool(
                "document_search", "Search documents", "Search current documents in the specified granted workspace.",
                json!({"workspaceId": workspace, "query": {"type": "string", "minLength": 1, "maxLength": 256}}),
                &["workspaceId", "query"], true, false,
            ),
            tool(
                "document_create", "Create document", "Create a new Markdown document with an immediate Git revision. The path must be unused.",
                json!({"workspaceId": workspace, "operationId": operation, "path": {"type": "string", "description": "Relative document path ending in .md."}, "markdown": markdown}),
                &["workspaceId", "operationId", "path", "markdown"], false, false,
            ),
            tool(
                "document_update", "Update document", "Replace a document conditionally on its current content revision and create a Git revision.",
                json!({"documentId": document, "operationId": operation, "baseRevision": revision, "markdown": markdown}),
                &["documentId", "operationId", "baseRevision", "markdown"], false, true,
            ),
            tool(
                "document_outline_read", "Read document outline", "Read the independent outline Markdown and its content revision. The revision is null when the outline is absent.",
                json!({"documentId": document}), &["documentId"], true, false,
            ),
            tool(
                "document_outline_update", "Update document outline", "Write the independent outline conditionally and create a Git revision.",
                json!({"documentId": document, "operationId": operation,
                    "baseRevision": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$", "description": "Content revision from document_outline_read, or null to create the outline."}, "markdown": markdown}),
                &["documentId", "operationId", "baseRevision", "markdown"], false, true,
            ),
            tool(
                "revision_list", "List document revisions", "List the Git revisions that changed this document.",
                json!({"documentId": document, "before": commit, "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}}),
                &["documentId"], true, false,
            ),
            tool(
                "revision_diff", "Read document revision diff", "Read what a Git revision changed in this document and the original Markdown at that revision.",
                json!({"documentId": document, "commitId": commit}), &["documentId", "commitId"], true, false,
            ),
            tool(
                "revision_restore", "Restore document revision", "Restore historical Markdown if the current content revision matches. This creates a new Git revision.",
                json!({"documentId": document, "operationId": operation, "baseRevision": revision, "commitId": commit}),
                &["documentId", "operationId", "baseRevision", "commitId"], false, true,
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
        let CallerCredential::Grant { grant_id, .. } = &caller.credential else {
            return error_result("A current OAuth grant is required");
        };
        match self.0.call(&caller.username, grant_id, name, args).await {
            Ok(result) => {
                if let (Some(data), Some(mime)) = (
                    result.get("imageBase64").and_then(Value::as_str),
                    result.get("mimeType").and_then(Value::as_str),
                ) {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        let mut structured = result.clone();
                        if let Some(object) = structured.as_object_mut() {
                            object.remove("imageBase64");
                        }
                        let mut response =
                            silverbullet_server_mcp::image_result_with_mime(&bytes, mime);
                        response["structuredContent"] = structured;
                        return response;
                    }
                }
                json_result(result)
            }
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

async fn invite_page() -> Response {
    let Some(page) = reader_asset("invite.html") else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; form-action 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
            ),
        ],
        Html(page.bytes),
    )
        .into_response()
}

fn sign_in_page(status: StatusCode, username: &str) -> Response {
    let state = match status {
        StatusCode::OK => "ready",
        StatusCode::UNAUTHORIZED => "incorrect",
        StatusCode::TOO_MANY_REQUESTS => "limited",
        _ => "unavailable",
    };
    auth_page(status, state, username)
}

fn auth_page(status: StatusCode, state: &str, username: &str) -> Response {
    let Some(page) = reader_asset("login.html") else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Ok(document) = std::str::from_utf8(&page.bytes) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
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
                // React Aria injects one <style> block for pressable
                // touch-action; pin its hash instead of allowing arbitrary
                // inline styles on the login page.
                "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

enum LoginNext {
    Session(String),
    Totp,
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
        headers
            .get("x-forwarded-for")
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
        if users.totp_enabled(&credentials.username) {
            attempt.succeeded();
            return Ok(LoginNext::Totp);
        }
        let jwt = verifier
            .issue_session(&credentials.username, false)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if users.credential_version(&credentials.username) != version {
            let _ = verifier.revoke_browser_session(&jwt);
            return Err(StatusCode::UNAUTHORIZED);
        }
        attempt.succeeded();
        Ok(LoginNext::Session(jwt))
    })
    .await;
    let token = match token {
        Ok(Ok(LoginNext::Session(token))) => token,
        Ok(Ok(LoginNext::Totp)) => {
            let Ok(challenge) = login.manager.issue_totp_challenge(&submitted_username) else {
                return sign_in_page(StatusCode::INTERNAL_SERVER_ERROR, &submitted_username);
            };
            let options = CookieOptions {
                path: "/.auth/librarian".into(),
                max_age_secs: Some(300),
                http_only: true,
                secure: is_secure_request(&headers),
                same_site: "Lax",
            };
            let cookie = set_cookie_value(
                &scoped_auth_cookie_name(&request_host(&headers), "totp"),
                &challenge,
                &options,
            );
            let Ok(cookie) = HeaderValue::from_str(&cookie) else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            let mut response = Redirect::to(&format!("{TOTP_PATH}?next={target}")).into_response();
            response.headers_mut().insert(header::SET_COOKIE, cookie);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return response;
        }
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

#[derive(Deserialize)]
struct TotpCode {
    code: String,
}

async fn totp_page_handler(
    State(login): State<LoginState>,
    Query(query): Query<LoginQuery>,
    headers: HeaderMap,
) -> Response {
    if query.target(&*login.mcp_enabled).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let host = request_host(&headers);
    let Some(challenge) = cookie_value(&headers, &scoped_auth_cookie_name(&host, "totp")) else {
        return auth_page(StatusCode::UNAUTHORIZED, "totp-expired", "");
    };
    let Some(claims) = login.manager.verify_totp_challenge(&challenge) else {
        return auth_page(StatusCode::UNAUTHORIZED, "totp-expired", "");
    };
    if login.users.credential_version(&claims.username).as_deref()
        != claims.credential_version.as_deref()
    {
        return auth_page(StatusCode::UNAUTHORIZED, "totp-expired", "");
    }
    auth_page(StatusCode::OK, "totp", &claims.username)
}

async fn totp_submit(
    State(login): State<LoginState>,
    Query(query): Query<LoginQuery>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Form(input): Form<TotpCode>,
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
    let host = request_host(&headers);
    let cookie_name = scoped_auth_cookie_name(&host, "totp");
    let Some(challenge) = cookie_value(&headers, &cookie_name) else {
        return auth_page(StatusCode::UNAUTHORIZED, "totp-expired", "");
    };
    let Some(claims) = login.manager.verify_totp_challenge(&challenge) else {
        return auth_page(StatusCode::UNAUTHORIZED, "totp-expired", "");
    };
    if login.users.credential_version(&claims.username).as_deref()
        != claims.credential_version.as_deref()
    {
        return auth_page(StatusCode::UNAUTHORIZED, "totp-expired", "");
    }
    let source = client_address(
        peer.map(|Extension(ConnectInfo(peer))| peer.ip()),
        login.trust_loopback_proxy,
        headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok()),
        headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok()),
    );
    let Some(attempt) = login
        .password_limits
        .reserve_login(&claims.username, source)
        .await
    else {
        return auth_page(
            StatusCode::TOO_MANY_REQUESTS,
            "totp-limited",
            &claims.username,
        );
    };
    let username = claims.username.clone();
    let verify_user = username.clone();
    let code = input.code;
    let verifier = login.manager.clone();
    let users = login.users.clone();
    let result = tokio::task::spawn_blocking(move || {
        let version = users.credential_version(&verify_user);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        if !users.verify_totp(&verify_user, &code, now)
            && !users.verify_recovery_code(&verify_user, &code)
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let jwt = verifier
            .issue_session(&verify_user, false)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if users.credential_version(&verify_user) != version {
            let _ = verifier.revoke_browser_session(&jwt);
            return Err(StatusCode::UNAUTHORIZED);
        }
        attempt.succeeded();
        Ok(jwt)
    })
    .await;
    let token = match result {
        Ok(Ok(token)) => token,
        Ok(Err(StatusCode::UNAUTHORIZED)) => {
            return auth_page(StatusCode::UNAUTHORIZED, "totp-incorrect", &username)
        }
        Ok(Err(status)) => return auth_page(status, "totp-unavailable", &username),
        Err(_) => {
            return auth_page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "totp-unavailable",
                &username,
            )
        }
    };
    let session = CookieOptions {
        path: "/".into(),
        max_age_secs: login
            .manager
            .cookie_max_age(&token)
            .and_then(|age| i64::try_from(age).ok()),
        http_only: true,
        secure: is_secure_request(&headers),
        same_site: "Lax",
    };
    let session_cookie = set_cookie_value(&scoped_auth_cookie_name(&host, ""), &token, &session);
    let cleared = set_cookie_value(
        &cookie_name,
        "",
        &CookieOptions {
            path: "/.auth/librarian".into(),
            max_age_secs: Some(0),
            http_only: true,
            secure: is_secure_request(&headers),
            same_site: "Lax",
        },
    );
    let (Ok(session_cookie), Ok(cleared)) = (
        HeaderValue::from_str(&session_cookie),
        HeaderValue::from_str(&cleared),
    ) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut response = Redirect::to(target).into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, session_cookie);
    response.headers_mut().append(header::SET_COOKIE, cleared);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_csp_allows_the_react_aria_pressable_style_without_unsafe_inline() {
        let response = sign_in_page(StatusCode::OK, "");
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("login CSP header")
            .to_str()
            .expect("login CSP is ASCII");
        assert!(csp.contains("'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='"));
        assert!(!csp.contains("'unsafe-inline'"));
    }
}
