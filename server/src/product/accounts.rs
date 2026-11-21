use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::multi::{
    config::{MemberEntry, MemberRole, SpaceConfig},
    users::{AccountSummary, Profile},
};

use super::{
    auth::Account,
    contract::ApiError,
    documents::{body, run, DocumentService},
    password_limits::{valid_password, PASSWORD_REQUIREMENTS},
    workspace,
};

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/accounts", get(list).post(create))
        .route("/accounts/{username}", axum::routing::patch(set_disabled))
        .route("/accounts/{username}/password", put(reset_password))
        .route(
            "/accounts/{username}/sessions/revoke",
            post(revoke_sessions),
        )
        .route("/session/password", put(change_password))
        .route("/workspaces/{workspace}/members", get(list_members))
        .route(
            "/workspaces/{workspace}/members/{username}",
            put(set_member).delete(remove_member),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
}

pub(super) fn browser(
    service: &DocumentService,
    headers: &HeaderMap,
    mutation: bool,
) -> Result<Account, ApiError> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "browser_session_required",
            "Sign in through the browser to continue",
        ));
    }
    Account::authenticate(&service.spaces, headers, mutation)
}

pub(super) fn administrator(
    service: &DocumentService,
    headers: &HeaderMap,
    mutation: bool,
) -> Result<Account, ApiError> {
    let account = browser(service, headers, mutation)?;
    if !service.spaces.users.is_admin(account.username()) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "account_admin_required",
            "Server administrator access is required",
        ));
    }
    Ok(account)
}

fn password(value: &str) -> Result<(), ApiError> {
    if !valid_password(value) {
        return Err(ApiError::invalid(PASSWORD_REQUIREMENTS));
    }
    Ok(())
}

fn account_error(error: String) -> ApiError {
    if error.starts_with("no such user ") {
        ApiError::not_found()
    } else if error.starts_with("user ") && error.ends_with(" already exists") {
        ApiError::new(
            StatusCode::CONFLICT,
            "account_exists",
            "The username is in use",
        )
    } else if error == "cannot disable the last admin" {
        ApiError::new(
            StatusCode::CONFLICT,
            "last_administrator",
            "The last server administrator must remain enabled",
        )
    } else if error == "account credentials changed" {
        ApiError::new(
            StatusCode::CONFLICT,
            "credentials_changed",
            "The account credentials changed. Sign in again",
        )
    } else if error == "SSO accounts do not have local passwords" {
        ApiError::invalid("This account uses an external identity provider")
    } else {
        ApiError::internal(error)
    }
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<Vec<AccountSummary>>, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        administrator(&service, &headers, false)?;
        Ok(Json(service.spaces.users.account_summaries()))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    username: String,
    password: String,
}

async fn create(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<Create>, JsonRejection>,
) -> Result<(StatusCode, Json<AccountSummary>), ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        administrator(&service, &headers, true)?;
        let input = body(input)?;
        let name = input.username.trim();
        if name.len() > 64
            || !name.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err(ApiError::invalid("Use a username of 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit"));
        }
        password(&input.password)?;
        let users = &service.spaces.users;
        users
            .create_user(name, &input.password, false, Profile::default())
            .map_err(account_error)?;
        service.spaces.manager.set_known_users(users.usernames());
        let summary = users.account_summary(name).ok_or_else(ApiError::not_found)?;
        Ok((StatusCode::CREATED, Json(summary)))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountState {
    disabled: bool,
}

async fn set_disabled(
    State(service): State<Arc<DocumentService>>,
    Path(username): Path<String>,
    headers: HeaderMap,
    input: Result<Json<AccountState>, JsonRejection>,
) -> Result<Json<AccountSummary>, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        administrator(&service, &headers, true)?;
        let input = body(input)?;
        let users = &service.spaces.users;
        let summary = users
            .account_summary(&username)
            .ok_or_else(ApiError::not_found)?;
        if summary.disabled == input.disabled {
            return Ok(Json(summary));
        }
        users
            .set_disabled_and_revoke_tokens(&username, input.disabled)
            .map_err(account_error)?;
        Ok(Json(
            users
                .account_summary(&username)
                .ok_or_else(ApiError::not_found)?,
        ))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Password {
    password: String,
}

async fn reset_password(
    State(service): State<Arc<DocumentService>>,
    Path(username): Path<String>,
    headers: HeaderMap,
    input: Result<Json<Password>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        administrator(&service, &headers, true)?;
        let input = body(input)?;
        password(&input.password)?;
        service
            .spaces
            .users
            .set_password_and_revoke_tokens(&username, &input.password, None)
            .map_err(account_error)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn revoke_sessions(
    State(service): State<Arc<DocumentService>>,
    Path(username): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        administrator(&service, &headers, true)?;
        service
            .spaces
            .users
            .bump_session_epoch(&username)
            .map_err(account_error)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnPassword {
    current_password: String,
    password: String,
}

async fn change_password(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<OwnPassword>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    run(move || {
        let account = browser(&service, &headers, true)?;
        let input = body(input)?;
        password(&input.password)?;
        let name = account.username();
        let users = &service.spaces.users;
        let attempt = service
            .spaces
            .password_limits
            .reserve(name, None)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "password_attempt_limit",
                    "Try again later",
                )
            })?;
        let version = users
            .credential_version(name)
            .ok_or_else(ApiError::not_found)?;
        if !users.verify_password(name, &input.current_password) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "incorrect_password",
                "The current password is incorrect",
            ));
        }
        users
            .set_password_and_revoke_tokens(name, &input.password, Some(&version))
            .map_err(account_error)?;
        attempt.succeeded();
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMember {
    username: String,
    role: MemberRole,
    is_owner: bool,
}

fn members(config: &SpaceConfig, owner: Option<&str>) -> Json<Vec<WorkspaceMember>> {
    Json(
        config
            .members
            .iter()
            .map(|(username, member)| WorkspaceMember {
                username: username.clone(),
                role: member.role,
                is_owner: owner == Some(username.as_str()),
            })
            .collect(),
    )
}

async fn list_members(
    State(service): State<Arc<DocumentService>>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<WorkspaceMember>>, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = browser(&service, &headers, false)?;
        let (instance, _) = workspace::require_manage(&service, &account, &workspace_id)?;
        let owner = workspace::info(&service.metadata, &workspace_id)?.owner;
        Ok(members(&instance.config, owner.as_deref()))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    role: MemberRole,
}

async fn set_member(
    State(service): State<Arc<DocumentService>>,
    Path((workspace_id, username)): Path<(String, String)>,
    headers: HeaderMap,
    input: Result<Json<Member>, JsonRejection>,
) -> Result<Json<Vec<WorkspaceMember>>, ApiError> {
    edit_member(
        service,
        workspace_id,
        username,
        headers,
        body(input).map(|entry| Some(entry.role)),
    )
    .await
}

async fn remove_member(
    State(service): State<Arc<DocumentService>>,
    Path((workspace_id, username)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<WorkspaceMember>>, ApiError> {
    edit_member(service, workspace_id, username, headers, Ok(None)).await
}

async fn edit_member(
    service: Arc<DocumentService>,
    workspace_id: String,
    username: String,
    headers: HeaderMap,
    role: Result<Option<MemberRole>, ApiError>,
) -> Result<Json<Vec<WorkspaceMember>>, ApiError> {
    run(move || {
        let _guard = service.metadata.workspace_guard()?;
        let account = browser(&service, &headers, true)?;
        let (instance, _) = workspace::require_manage(&service, &account, &workspace_id)?;
        let role = role?;
        let owner = workspace::info(&service.metadata, &workspace_id)?.owner;
        if owner.as_deref() == Some(username.as_str()) && role != Some(MemberRole::Write) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "workspace_owner_protected",
                "The workspace creator must retain write access",
            ));
        }
        let mut config = instance.config.clone();
        if let Some(role) = role {
            if !service.spaces.users.is_enabled(&username) {
                return Err(ApiError::invalid("Select an enabled account"));
            }
            let member = config
                .members
                .entry(username)
                .or_insert_with(|| MemberEntry {
                    runtime_api: false,
                    ..MemberEntry::default()
                });
            member.role = role;
        } else {
            config.members.remove(&username);
        }
        let response = members(&config, owner.as_deref());
        if config != instance.config {
            service
                .spaces
                .manager
                .update(&instance.id, config)
                .map_err(workspace::native_error)?;
        }
        Ok(response)
    })
    .await
}
