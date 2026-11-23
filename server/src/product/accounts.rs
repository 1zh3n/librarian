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
    audit,
    auth::Account,
    contract::ApiError,
    documents::{body, run, DocumentService},
    invites,
    password_limits::{valid_password, PASSWORD_REQUIREMENTS},
    workspace,
};
use crate::auth::totp;

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
        .route("/session/totp", get(totp_status))
        .route("/session/totp/start", post(totp_start))
        .route("/session/totp/verify", post(totp_verify))
        .route("/session/totp/disable", post(totp_disable))
        .route("/session/step-up", post(step_up))
        .route("/accounts/{username}/totp/reset", post(reset_totp))
        .route("/invites", get(list_invites).post(create_invite))
        .route(
            "/invites/{token}",
            get(invite_preview).delete(revoke_invite),
        )
        .route("/invites/{token}/accept", post(accept_invite))
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
    } else if error == "two-factor is already enabled" {
        ApiError::new(
            StatusCode::CONFLICT,
            "totp_already_enabled",
            "Two-factor authentication is already enabled",
        )
    } else if error == "two-factor is not enabled" {
        ApiError::new(
            StatusCode::CONFLICT,
            "totp_not_enabled",
            "Two-factor authentication is not enabled",
        )
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
struct TotpStatus {
    enabled: bool,
    recovery_remaining: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TotpStart {
    secret: String,
    uri: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TotpVerify {
    secret: String,
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TotpEnabled {
    recovery_codes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TotpDisable {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StepUpInput {
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepUpToken {
    token: String,
    expires_in: u64,
}

async fn step_up(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<StepUpInput>, JsonRejection>,
) -> Result<Json<StepUpToken>, ApiError> {
    let account = browser(&service, &headers, true)?;
    let input = body(input)?;
    run(move || {
        let users = &service.spaces.users;
        if !users.totp_enabled(account.username()) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "totp_required",
                "Enable two-factor authentication before this action",
            ));
        }
        let Some(attempt) = service
            .spaces
            .password_limits
            .reserve(account.username(), None)
        else {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many verification attempts",
            ));
        };
        let now = chrono::Utc::now().timestamp() as u64;
        if !users.verify_totp(account.username(), &input.code, now)
            && !users.verify_recovery_code(account.username(), &input.code)
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "invalid_totp_code",
                "The verification code is not valid",
            ));
        }
        let version = users
            .credential_version(account.username())
            .ok_or_else(|| ApiError::internal("Account is unavailable"))?;
        let token = service
            .spaces
            .authenticator
            .issue_step_up(account.username(), Some(version))
            .map_err(ApiError::internal)?;
        attempt.succeeded();
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(account.username()),
                workspace: None,
                action: "account.step_up",
                target: Some(account.username()),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok(Json(StepUpToken {
            token,
            expires_in: 300,
        }))
    })
    .await
}

async fn totp_status(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<TotpStatus>, ApiError> {
    let account = browser(&service, &headers, false)?;
    run(move || {
        let users = &service.spaces.users;
        Ok(Json(TotpStatus {
            enabled: users.totp_enabled(account.username()),
            recovery_remaining: users.recovery_remaining(account.username()),
        }))
    })
    .await
}

async fn totp_start(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<TotpStart>, ApiError> {
    let account = browser(&service, &headers, false)?;
    run(move || {
        if service.spaces.users.totp_enabled(account.username()) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "totp_already_enabled",
                "Two-factor authentication is already enabled",
            ));
        }
        let secret = totp::generate_secret();
        Ok(Json(TotpStart {
            uri: totp::otpauth_uri("Librarian", account.username(), &secret),
            secret,
        }))
    })
    .await
}

async fn totp_verify(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<TotpVerify>, JsonRejection>,
) -> Result<Json<TotpEnabled>, ApiError> {
    let account = browser(&service, &headers, true)?;
    let input = body(input)?;
    run(move || {
        let users = &service.spaces.users;
        if users.totp_enabled(account.username()) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "totp_already_enabled",
                "Two-factor authentication is already enabled",
            ));
        }
        let now = chrono::Utc::now().timestamp() as u64;
        if totp::verify(&input.secret, &input.code, now).is_none() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "invalid_totp_code",
                "The verification code is not valid",
            ));
        }
        let (plain, hashed) = totp::generate_recovery_codes(10);
        users
            .enable_totp(account.username(), &input.secret, hashed)
            .map_err(account_error)?;
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(account.username()),
                workspace: None,
                action: "account.totp.enable",
                target: Some(account.username()),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok(Json(TotpEnabled {
            recovery_codes: plain,
        }))
    })
    .await
}

async fn totp_disable(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<TotpDisable>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let account = browser(&service, &headers, true)?;
    let input = body(input)?;
    run(move || {
        let users = &service.spaces.users;
        let now = chrono::Utc::now().timestamp() as u64;
        if !users.verify_totp(account.username(), &input.code, now)
            && !users.verify_recovery_code(account.username(), &input.code)
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "invalid_totp_code",
                "The verification code is not valid",
            ));
        }
        users
            .disable_totp(account.username())
            .map_err(account_error)?;
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(account.username()),
                workspace: None,
                action: "account.totp.disable",
                target: Some(account.username()),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn reset_totp(
    State(service): State<Arc<DocumentService>>,
    Path(username): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let administrator = administrator(&service, &headers, true)?;
    run(move || {
        service
            .spaces
            .users
            .reset_totp(&username)
            .map_err(account_error)?;
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(administrator.username()),
                workspace: None,
                action: "account.totp.reset",
                target: Some(&username),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInvite {
    username: String,
    #[serde(default)]
    admin: bool,
    role: MemberRole,
    #[serde(default)]
    workspace_ids: Vec<String>,
    #[serde(default)]
    expires_in_days: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedInvite {
    id: String,
    username: String,
    token: String,
    url: String,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteWorkspace {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteSummary {
    id: String,
    username: String,
    admin: bool,
    role: MemberRole,
    workspace_ids: Vec<String>,
    workspaces: Vec<InviteWorkspace>,
    created_by: String,
    created_at: i64,
    expires_at: i64,
    accepted_at: Option<i64>,
    revoked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitePreview {
    username: String,
    expires_at: i64,
    workspaces: Vec<InviteWorkspace>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptInvite {
    password: String,
    totp_secret: String,
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedInvite {
    recovery_codes: Vec<String>,
}

fn invite_workspaces(service: &DocumentService, ids: &[String]) -> Vec<InviteWorkspace> {
    ids.iter()
        .filter_map(|id| {
            let space = service.metadata.space_id(id).ok()?;
            let instance = service.spaces.manager.instance(&space)?;
            Some(InviteWorkspace {
                id: id.clone(),
                name: instance.config.name.clone(),
            })
        })
        .collect()
}

fn resolve_invite_spaces(
    service: &DocumentService,
    ids: &[String],
) -> Result<Vec<(String, String)>, ApiError> {
    ids.iter()
        .map(|id| {
            let space = service.metadata.space_id(id)?;
            service
                .spaces
                .manager
                .instance(&space)
                .map(|instance| (id.clone(), instance.id.clone()))
                .ok_or_else(|| ApiError::invalid("Invite workspace is unavailable"))
        })
        .collect()
}

async fn list_invites(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<Json<Vec<InviteSummary>>, ApiError> {
    administrator(&service, &headers, false)?;
    run(move || {
        let list = invites::list(&service.metadata)?;
        Ok(Json(
            list.into_iter()
                .map(|invite| InviteSummary {
                    workspaces: invite_workspaces(&service, &invite.workspace_ids),
                    id: invite.id,
                    username: invite.username,
                    admin: invite.admin,
                    role: invite.role,
                    workspace_ids: invite.workspace_ids,
                    created_by: invite.created_by,
                    created_at: invite.created_at,
                    expires_at: invite.expires_at,
                    accepted_at: invite.accepted_at,
                    revoked: invite.revoked,
                })
                .collect(),
        ))
    })
    .await
}

async fn create_invite(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
    input: Result<Json<CreateInvite>, JsonRejection>,
) -> Result<(StatusCode, Json<CreatedInvite>), ApiError> {
    let administrator = administrator(&service, &headers, true)?;
    let input = body(input)?;
    let username = input.username.trim().to_owned();
    if username.is_empty() || username.contains([':', '/']) {
        return Err(ApiError::invalid("Expected a valid username"));
    }
    if service.spaces.users.user_exists(&username) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "account_exists",
            "The username is in use",
        ));
    }
    let days = if input.expires_in_days == 0 {
        7
    } else {
        input.expires_in_days.clamp(1, 30)
    };
    run(move || {
        resolve_invite_spaces(&service, &input.workspace_ids)?;
        let (token, invite) = invites::create(
            &service.metadata,
            invites::NewInvite {
                username,
                admin: input.admin,
                role: input.role,
                workspace_ids: input.workspace_ids,
                created_by: administrator.username().to_owned(),
                expires_at: chrono::Utc::now().timestamp() + i64::from(days) * 86_400,
            },
        )?;
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(administrator.username()),
                workspace: None,
                action: "account.invite.create",
                target: Some(&invite.username),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok((
            StatusCode::CREATED,
            Json(CreatedInvite {
                url: format!("/.auth/librarian/invite?token={token}"),
                id: invite.id,
                username: invite.username,
                token,
                expires_at: invite.expires_at,
            }),
        ))
    })
    .await
}

async fn invite_preview(
    State(service): State<Arc<DocumentService>>,
    Path(token): Path<String>,
) -> Result<Json<InvitePreview>, ApiError> {
    run(move || {
        let now = chrono::Utc::now().timestamp();
        let invite = invites::find_by_token(&service.metadata, &token, now)?;
        Ok(Json(InvitePreview {
            username: invite.username.clone(),
            expires_at: invite.expires_at,
            workspaces: invite_workspaces(&service, &invite.workspace_ids),
        }))
    })
    .await
}

async fn revoke_invite(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let administrator = administrator(&service, &headers, true)?;
    run(move || {
        invites::revoke(&service.metadata, &id)?;
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(administrator.username()),
                workspace: None,
                action: "account.invite.revoke",
                target: Some(&id),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn accept_invite(
    State(service): State<Arc<DocumentService>>,
    Path(token): Path<String>,
    input: Result<Json<AcceptInvite>, JsonRejection>,
) -> Result<Json<AcceptedInvite>, ApiError> {
    let input = body(input)?;
    password(&input.password)?;
    run(move || {
        let now = chrono::Utc::now().timestamp();
        let invite = invites::find_by_token(&service.metadata, &token, now)?;
        if service.spaces.users.user_exists(&invite.username) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "account_exists",
                "The username is in use",
            ));
        }
        if totp::verify(&input.totp_secret, &input.code, now as u64).is_none() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "invalid_totp_code",
                "The verification code is not valid",
            ));
        }
        let spaces = resolve_invite_spaces(&service, &invite.workspace_ids)?;
        let mut previous = Vec::with_capacity(spaces.len());
        for (_, space) in &spaces {
            let instance = service
                .spaces
                .manager
                .instance(space)
                .ok_or_else(|| ApiError::invalid("Invite workspace is unavailable"))?;
            previous.push((space.clone(), instance.config.clone()));
        }
        service
            .spaces
            .users
            .create_user(
                &invite.username,
                &input.password,
                invite.admin,
                Profile::default(),
            )
            .map_err(account_error)?;
        service
            .spaces
            .manager
            .set_known_users(service.spaces.users.usernames());
        let rollback = |service: &DocumentService| {
            service
                .spaces
                .users
                .delete_user(&invite.username)
                .map_err(ApiError::internal)?;
            for (space, config) in &previous {
                service
                    .spaces
                    .manager
                    .update(space, config.clone())
                    .map_err(workspace::native_error)?;
            }
            Ok::<(), ApiError>(())
        };
        for (_, space) in &spaces {
            let Some(instance) = service.spaces.manager.instance(space) else {
                rollback(&service)?;
                return Err(ApiError::invalid("Invite workspace is unavailable"));
            };
            let mut config = instance.config.clone();
            config.members.insert(
                invite.username.clone(),
                MemberEntry {
                    role: invite.role,
                    runtime_api: false,
                    ..MemberEntry::default()
                },
            );
            if let Err(error) = service.spaces.manager.update(space, config) {
                rollback(&service)?;
                return Err(workspace::native_error(error));
            }
        }
        let (plain, hashed) = totp::generate_recovery_codes(10);
        if service
            .spaces
            .users
            .enable_totp(&invite.username, &input.totp_secret, hashed)
            .is_err()
        {
            rollback(&service)?;
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "totp_already_enabled",
                "Two-factor authentication is already enabled",
            ));
        }
        if let Err(error) = invites::accept(&service.metadata, &invite.id, now) {
            rollback(&service)?;
            return Err(error);
        }
        audit::record(
            &service.metadata,
            audit::Event {
                actor: Some(&invite.username),
                workspace: None,
                action: "account.invite.accept",
                target: Some(&invite.username),
                result: "ok",
                rule_id: None,
                request_id: None,
                metadata: None,
            },
        )?;
        Ok(Json(AcceptedInvite {
            recovery_codes: plain,
        }))
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
        let (config, owner) =
            change_member_under_guard(&service, &account, &workspace_id, username, role, None)?;
        Ok(members(&config, owner.as_deref()))
    })
    .await
}

pub(super) fn change_member_under_guard(
    service: &DocumentService,
    account: &Account,
    workspace_id: &str,
    username: String,
    role: Result<Option<MemberRole>, ApiError>,
    operation_id: Option<&str>,
) -> Result<(SpaceConfig, Option<String>), ApiError> {
    let (instance, _) = workspace::require_manage(service, account, workspace_id)?;
    let role = role?;
    let owner = workspace::info(&service.metadata, workspace_id)?.owner;
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
    workspace::mark_management_operation(&mut config, operation_id);
    if config != instance.config {
        service
            .spaces
            .manager
            .update(&instance.id, config.clone())
            .map_err(workspace::native_error)?;
    }
    Ok((config, owner))
}
