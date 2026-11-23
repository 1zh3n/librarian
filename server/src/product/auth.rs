use std::collections::BTreeSet;

use axum::http::{header, HeaderMap, StatusCode};

use crate::auth::{request_origin, AccessLevel, Actor};
use crate::multi::{access::signed_in_user, config::MemberRole, instance::SpaceInstance};

use super::{contract::ApiError, space_adapter::NativeSpaces};

pub(crate) struct Account {
    username: String,
    bound: Option<BoundIdentity>,
}

struct BoundIdentity {
    credential_version: String,
    allowed_spaces: BTreeSet<String>,
}

impl Account {
    pub(super) fn username(&self) -> &str {
        &self.username
    }

    pub(crate) fn authenticate(
        spaces: &NativeSpaces,
        headers: &HeaderMap,
        mutation: bool,
    ) -> Result<Self, ApiError> {
        let unauthenticated = || {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Sign in to continue",
            )
        };
        let username = if let Some(header) = headers.get(header::AUTHORIZATION) {
            let (_, token) = header
                .to_str()
                .ok()
                .and_then(|value| value.split_once(' '))
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
                .ok_or_else(unauthenticated)?;
            spaces
                .users
                .resolve_token(token)
                .ok_or_else(unauthenticated)?
        } else {
            let username = signed_in_user(&spaces.authenticator, &spaces.users, headers)
                .ok_or_else(unauthenticated)?;
            if mutation
                && headers
                    .get(header::ORIGIN)
                    .and_then(|value| value.to_str().ok())
                    != Some(request_origin(headers).as_str())
            {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "origin_mismatch",
                    "Write must come from this origin",
                ));
            }
            username
        };
        Ok(Self {
            username,
            bound: None,
        })
    }

    pub(super) fn from_bound_identity(
        spaces: &NativeSpaces,
        username: &str,
        credential_version: Option<&str>,
        allowed_spaces: BTreeSet<String>,
    ) -> Result<Self, ApiError> {
        let version = credential_version
            .filter(|version| spaces.users.session_is_current(username, Some(version)))
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "The account credentials have changed",
                )
            })?;
        Ok(Self {
            username: username.to_owned(),
            bound: Some(BoundIdentity {
                credential_version: version.to_owned(),
                allowed_spaces,
            }),
        })
    }

    pub(crate) fn actor(
        &self,
        spaces: &NativeSpaces,
        instance: &SpaceInstance,
        write: bool,
    ) -> Result<Actor, ApiError> {
        if let Some(bound) = &self.bound {
            if !bound.allowed_spaces.contains(&instance.id)
                || !spaces
                    .users
                    .session_is_current(&self.username, Some(&bound.credential_version))
            {
                return Err(ApiError::not_found());
            }
        }
        let level = effective_level(spaces, instance, &self.username)?;
        if level < AccessLevel::Read {
            return Err(ApiError::not_found());
        }
        if write && level < AccessLevel::Write {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "read_only",
                "Workspace is read-only for this account",
            ));
        }
        let profile = super::documents::state(instance)?
            .identity
            .resolve(Some(&self.username));
        Ok(Actor {
            username: profile.username,
            credential_version: spaces.users.credential_version(&self.username),
            full_name: profile.full_name,
            email: profile.email,
            level,
        })
    }
}

/// The product only exposes spaces through active accounts with membership or administration rights.
pub(super) fn effective_level(
    spaces: &NativeSpaces,
    instance: &SpaceInstance,
    username: &str,
) -> Result<AccessLevel, ApiError> {
    if !spaces.users.is_enabled(username) {
        return Ok(AccessLevel::None);
    }
    let member = if spaces.users.is_admin(username) {
        AccessLevel::Write
    } else {
        match instance
            .config
            .members
            .get(username)
            .map(|member| member.role)
        {
            Some(MemberRole::Write) => AccessLevel::Write,
            Some(MemberRole::Read) => AccessLevel::Read,
            None => return Ok(AccessLevel::None),
        }
    };
    Ok(super::documents::state(instance)?
        .access_policy
        .level_for(Some(username))
        .min(member))
}

/// Sensitive actions require a recent step-up only for accounts that have
/// enrolled TOTP. Accounts without TOTP keep the existing confirmation path
/// until enrolment is mandatory.
pub(super) fn require_step_up_if_enrolled(
    spaces: &NativeSpaces,
    account: &Account,
    token: Option<&str>,
) -> Result<(), ApiError> {
    if !spaces.users.totp_enabled(account.username()) {
        return Ok(());
    }
    let Some(token) = token else {
        return Err(step_up_required());
    };
    let Some(claims) = spaces.authenticator.verify_step_up(token) else {
        return Err(step_up_required());
    };
    let version = spaces.users.credential_version(account.username());
    if claims.username != account.username() || claims.credential_version != version {
        return Err(step_up_required());
    }
    Ok(())
}

fn step_up_required() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "step_up_required",
        "Re-enter two-factor authentication to continue",
    )
}
