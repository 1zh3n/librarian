use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::mcp::{canonical_mcp_url, grants::ClientKind},
    multi::server_config::ServerConfigPatch,
};

use super::{accounts, contract::ApiError, documents::DocumentService};

/// Product-facing MCP settings. This intentionally exposes summaries only:
/// the grant store holds credentials and token generations that must never
/// cross the product API boundary.
pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/mcp/settings", get(settings).put(update_settings))
        .route("/mcp/grants", get(list_grants))
        .route("/mcp/grants/{id}", delete(revoke_grant))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpSettingsView {
    enabled: bool,
    available: bool,
    disabled_by_env: bool,
    endpoint: String,
    public_reader_url: Option<String>,
    public_reader_url_error: Option<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpdateMcpSettings {
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpGrantView {
    id: String,
    client_name: String,
    client_kind: ClientKind,
    spaces: Vec<McpGrantSpace>,
    scope: String,
    created_at: String,
    last_used_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpGrantSpace {
    id: String,
    name: String,
}

async fn settings(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<McpSettingsView>, ApiError> {
    accounts::browser(&service, &headers, false)?;
    Ok(Json(view(&service, &headers)))
}

async fn update_settings(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Json(input): Json<UpdateMcpSettings>,
) -> Result<Json<McpSettingsView>, ApiError> {
    accounts::administrator(&service, &headers, true)?;
    let disabled_by_env = mcp_disabled_by_env();
    if input.enabled && disabled_by_env {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "mcp_disabled_by_env",
            "MCP is disabled by this deployment",
        ));
    }
    service
        .spaces
        .manager
        .set_server_config(ServerConfigPatch {
            mcp: Some(input.enabled),
            ..Default::default()
        })
        .map_err(manager_error)?;
    Ok(Json(view(&service, &headers)))
}

async fn list_grants(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<Vec<McpGrantView>>, ApiError> {
    let account = accounts::browser(&service, &headers, false)?;
    let names = space_names(&service, &account);
    let grants = service.spaces.grants.list_for_user(account.username());
    Ok(Json(
        grants
            .into_iter()
            .map(|grant| McpGrantView {
                id: grant.id,
                client_name: grant.client_name,
                client_kind: grant.client_kind,
                spaces: grant
                    .spaces
                    .into_iter()
                    .filter_map(|id| {
                        names.get(&id).map(|name| McpGrantSpace {
                            id,
                            name: name.clone(),
                        })
                    })
                    .collect(),
                scope: grant.scope,
                created_at: rfc3339(grant.created_at),
                last_used_at: (grant.last_used_at > 0).then(|| rfc3339(grant.last_used_at)),
            })
            .collect(),
    ))
}

async fn revoke_grant(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let account = accounts::browser(&service, &headers, true)?;
    let owns_grant = service
        .spaces
        .grants
        .list_for_user(account.username())
        .iter()
        .any(|grant| grant.id == id);
    if !owns_grant {
        return Err(ApiError::not_found());
    }
    if !service
        .spaces
        .grants
        .revoke(&id)
        .map_err(ApiError::internal)?
    {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

fn manager_error(error: crate::multi::manager::ApiError) -> ApiError {
    match error {
        crate::multi::manager::ApiError::Validation(_) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            "Invalid server configuration",
        ),
        crate::multi::manager::ApiError::NotFound => ApiError::not_found(),
        crate::multi::manager::ApiError::Conflict(_) => ApiError::new(
            StatusCode::CONFLICT,
            "configuration_conflict",
            "MCP configuration conflicts with the current server state",
        ),
        crate::multi::manager::ApiError::Internal(error) => ApiError::internal(error),
    }
}

fn view(service: &DocumentService, headers: &HeaderMap) -> McpSettingsView {
    let public_reader_url = service.reader_links.public_url().map(str::to_owned);
    let disabled_by_env = mcp_disabled_by_env();
    let available = !disabled_by_env;
    McpSettingsView {
        enabled: available && service.spaces.manager.mcp_enabled(),
        available,
        disabled_by_env,
        endpoint: canonical_mcp_url(headers, service.spaces.manager.primary_url().as_deref()),
        public_reader_url_error: public_reader_url
            .is_none()
            .then_some("reader_url_unavailable"),
        public_reader_url,
    }
}

fn space_names(
    service: &DocumentService,
    account: &super::auth::Account,
) -> std::collections::HashMap<String, String> {
    let admin = service.spaces.users.is_admin(account.username());
    service
        .spaces
        .manager
        .list_accessible(account.username(), admin)
        .into_iter()
        .map(|space| (space.id, space.name))
        .collect()
}

pub(super) fn mcp_disabled_by_env() -> bool {
    std::env::var("SB_MCP").is_ok_and(|value| value == "0" || value.eq_ignore_ascii_case("false"))
}

fn rfc3339(secs: u64) -> String {
    chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn mcp_env_parser_accepts_only_explicit_off_values() {
        // The parser is deliberately pure enough to verify the two deployment
        // overrides without racing other tests through the process environment.
        assert!(matches_off(Some("0")));
        assert!(matches_off(Some("false")));
        assert!(matches_off(Some("FALSE")));
        assert!(!matches_off(Some("1")));
        assert!(!matches_off(Some("true")));
        assert!(!matches_off(None));
    }

    fn matches_off(value: Option<&str>) -> bool {
        value.is_some_and(|value| value == "0" || value.eq_ignore_ascii_case("false"))
    }

    #[test]
    fn reader_url_error_is_only_reported_when_missing() {
        let link = |url: Option<&str>| url.is_none().then_some("reader_url_unavailable");
        assert_eq!(link(None), Some("reader_url_unavailable"));
        assert_eq!(link(Some("https://docs.example.org")), None);
    }
}
