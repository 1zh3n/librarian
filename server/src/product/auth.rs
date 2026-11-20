use axum::http::{header, HeaderMap, StatusCode};

use crate::auth::{request_origin, AccessLevel, Actor};
use crate::multi::{access::signed_in_user, config::MemberRole, instance::SpaceInstance};

use super::{contract::ApiError, space_adapter::NativeSpaces};

pub(crate) struct Account {
    username: String,
}

impl Account {
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
        Ok(Self { username })
    }

    pub(crate) fn actor(
        &self,
        spaces: &NativeSpaces,
        instance: &SpaceInstance,
        write: bool,
    ) -> Result<Actor, ApiError> {
        if !spaces.users.is_enabled(&self.username) {
            return Err(ApiError::not_found());
        }
        let member_level = if spaces.users.is_admin(&self.username) {
            AccessLevel::Write
        } else {
            match instance
                .config
                .members
                .get(&self.username)
                .map(|member| member.role)
            {
                Some(MemberRole::Write) => AccessLevel::Write,
                Some(MemberRole::Read) => AccessLevel::Read,
                None => return Err(ApiError::not_found()),
            }
        };
        let state = instance.state.as_ref().ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "space_unavailable",
                "Workspace is unavailable",
            )
        })?;
        let level = state
            .access_policy
            .level_for(Some(&self.username))
            .min(member_level);
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
        let profile = state.identity.resolve(Some(&self.username));
        Ok(Actor {
            username: profile.username,
            credential_version: spaces.users.credential_version(&self.username),
            full_name: profile.full_name,
            email: profile.email,
            level,
        })
    }
}
