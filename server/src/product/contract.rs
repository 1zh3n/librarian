use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Deserializer, Serialize};
use silverbullet_server_common::SpaceError;

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_revision: Option<String>,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            body: ErrorBody {
                code,
                message,
                current_revision: None,
            },
        }
    }

    pub(crate) fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "Resource not found")
    }

    pub(crate) fn invalid(message: &'static str) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_request", message)
    }

    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!("Librarian request failed: {error}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Request could not be completed",
        )
    }

    pub(crate) fn conflict(current_revision: Option<String>) -> Self {
        let mut error = Self::new(
            StatusCode::CONFLICT,
            "revision_conflict",
            "Document revision changed",
        );
        error.body.current_revision = current_revision;
        error
    }
}

impl From<SpaceError> for ApiError {
    fn from(error: SpaceError) -> Self {
        match error {
            SpaceError::NotFound | SpaceError::PathOutsideRoot => Self::not_found(),
            error => Self::internal(error),
        }
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workspace {
    pub id: String,
    pub space_id: String,
    pub name: String,
    pub origin: &'static str,
    pub retention: &'static str,
    pub revision_mode: &'static str,
    pub defaults: WorkspaceDefaults,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDefaults {
    pub outline_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentSummary {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    pub title: String,
    pub outline_enabled: bool,
}

#[derive(Serialize)]
pub(crate) struct DocumentSnapshot {
    pub document: DocumentSummary,
    pub markdown: String,
    pub revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteMarkdown {
    pub markdown: String,
    #[serde(default, deserialize_with = "present_revision")]
    pub base_revision: Option<Option<String>>,
}

fn present_revision<'de, D: Deserializer<'de>>(
    value: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::deserialize(value).map(Some)
}

impl WriteMarkdown {
    pub(crate) fn precondition(&self) -> Result<Option<&str>, ApiError> {
        let expected = self
            .base_revision
            .as_ref()
            .map(Option::as_deref)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::PRECONDITION_REQUIRED,
                    "precondition_required",
                    "baseRevision is required",
                )
            })?;
        if expected.is_some_and(|revision| {
            revision.len() != 64
                || !revision
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        }) {
            return Err(ApiError::invalid("Expected a SHA-256 content revision"));
        }
        Ok(expected)
    }
}

#[derive(Deserialize)]
pub(crate) struct CreateDocument {
    pub path: String,
    #[serde(flatten)]
    pub content: WriteMarkdown,
}
