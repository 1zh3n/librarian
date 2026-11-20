use std::{path::Path, sync::Arc};

use axum::{
    extract::{DefaultBodyLimit, Form, Query, State},
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
    multi::access::AnyUserAuth,
    product::space_adapter::NativeSpaces,
};
use silverbullet_server_common::space::EmbeddedSpace;

use crate::assets::ConsentAssets;
use silverbullet_server_mcp::{
    error_result, json_result, mcp_router_gated, Caller, McpHost, MultiHost, ToolDef, ToolResult,
    ToolSet,
};

const LOGIN_PATH: &str = "/.auth/librarian/login";
const CONSENT_PATH: &str = "/.auth/mcp/authorize";
type McpEnabled = Arc<dyn Fn() -> bool + Send + Sync>;
const LOGIN_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 Librarian</title></head>
<body><main>
<h1>登录 Librarian</h1>
<form method="post">
<label>用户名 <input name="username" autocomplete="username" required></label>
<label>密码 <input type="password" name="password" autocomplete="current-password" required></label>
<button>登录</button>
</form>
</main></body></html>"#;

pub fn build(root: &Path, spaces: &NativeSpaces) -> Result<(Arc<MultiHost>, Router), String> {
    let clients = Arc::new(ClientRegistry::load(root).map_err(|err| err.to_string())?);
    let grants = Arc::new(GrantStore::load(root).map_err(|err| err.to_string())?);
    let host = Arc::new(
        MultiHost::new(spaces.manager.clone(), spaces.users.clone())
            .with_oauth(spaces.authenticator.clone(), grants.clone())
            .with_login_path(LOGIN_PATH),
    );
    let users = spaces.users.clone();
    let login = Arc::new(
        LoginManager::new(
            spaces.authenticator.clone(),
            Arc::new(AnyUserAuth {
                store: spaces.users.clone(),
            }),
            spaces.session.session_idle_secs,
            spaces.session.lockout(),
            String::new(),
        )
        .with_credential_version(Arc::new(move |username| {
            users.credential_version(username).unwrap_or_default()
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
    let tools = Arc::new(WorkspaceTools(host.clone()));
    let login_router = Router::new()
        .route(
            LOGIN_PATH,
            get(login_page)
                .post(login_submit)
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .with_state(LoginState {
            manager: login,
            mcp_enabled: enabled.clone(),
        });
    let router = mcp_router_gated(tools, host.clone(), enabled.clone())
        .merge(mcp_oauth::router(oauth, enabled))
        .merge(login_router);
    Ok((host, router))
}

struct WorkspaceTools(Arc<MultiHost>);

#[async_trait::async_trait]
impl ToolSet for WorkspaceTools {
    fn tools(&self) -> Vec<ToolDef> {
        vec![ToolDef {
            name: "workspace_list",
            title: "List workspaces",
            description: "List Librarian workspaces covered by the current grant.".into(),
            input_schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
            annotations: json!({"readOnlyHint": true}),
        }]
    }

    fn instructions(&self) -> String {
        "List the Librarian workspaces available to this connection.".into()
    }

    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").into()
    }

    async fn call(&self, caller: &Caller, name: &str, args: Value) -> ToolResult {
        if name != "workspace_list" || !args.as_object().is_some_and(|object| object.is_empty()) {
            return error_result("workspace_list does not accept arguments");
        }
        let workspaces: Vec<_> = self
            .0
            .spaces(caller)
            .into_iter()
            .map(|space| json!({"id": space.id, "name": space.name}))
            .collect();
        json_result(json!({"workspaces": workspaces}))
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
            ["", ""] => true,
            ["", "workspaces", workspace] => id(workspace),
            ["", "workspaces", workspace, "documents", document] => id(workspace) && id(document),
            _ => false,
        };
        known_route.then_some(next)
    }
}

async fn login_page(State(login): State<LoginState>, Query(query): Query<LoginQuery>) -> Response {
    if query.target(&*login.mcp_enabled).is_none() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            ),
        ],
        Html(LOGIN_PAGE),
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

    let verifier = login.manager.clone();
    let token = tokio::task::spawn_blocking(move || {
        if verifier.is_locked() {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        if !verifier.authorize(&credentials.username, &credentials.password) {
            verifier.record_failure();
            return Err(StatusCode::UNAUTHORIZED);
        }
        verifier
            .issue_session(&credentials.username, false)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    })
    .await;
    let token = match token {
        Ok(Ok(token)) => token,
        Ok(Err(status)) => return status.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
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
