use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;

use super::{
    ai::{Mode, Operation, OperationStatus},
    ai_configuration::{check_selection, saved_credential},
    ai_probes::{self, ProbeAction},
    contract::ApiError,
    documents::{run, DocumentService},
};

#[derive(Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Protocol {
    #[default]
    Legacy,
    Managed,
}

impl Protocol {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Managed => "managed",
        }
    }
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/runner/v2/heartbeat", post(heartbeat))
        .route("/ai/runner/v2/claims/{lease}/provider", get(provider))
        .merge(super::ai_materials::runner_routes(material_lease))
}

pub(super) fn disabled() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "ai_disabled", "AI is paused")
}
fn inactive() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "lease_inactive",
        "The execution lease is no longer active",
    )
}
fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "runner_unauthorized",
        "A valid runner instance is required",
    )
}

pub(super) fn instance(service: &DocumentService, headers: &HeaderMap) -> Result<String, ApiError> {
    let id = headers
        .get("x-librarian-runner-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(unauthorized)?;
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, token)| {
            scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && token.len() <= 512
        })
        .map(|(_, token)| token)
        .ok_or_else(unauthorized)?;
    let expected: Option<String> = service
        .metadata
        .connection()?
        .query_row(
            "SELECT token_digest FROM ai_runner_instances WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let digest = sha256_hex(token.as_bytes());
    let matches = expected.is_some_and(|v| {
        v.len() == digest.len()
            && v.bytes()
                .zip(digest.bytes())
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                == 0
    });
    if !matches {
        return Err(unauthorized());
    }
    Ok(id.into())
}

async fn heartbeat(
    State(service): State<Arc<DocumentService>>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    run(move || {
        let id = instance(&service, &headers)?;
        service.metadata.connection()?.execute(
            "UPDATE ai_runner_instances SET last_seen=unixepoch() WHERE id=?",
            [id],
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

pub(super) fn enabled(service: &DocumentService) -> Result<bool, ApiError> {
    Ok(service.metadata.connection()?.query_row(
        "SELECT enabled FROM ai_configuration WHERE singleton=1",
        [],
        |r| r.get(0),
    )?)
}

// Called under the AI guard alongside the mutation or state transition.
pub(super) fn valid(service: &DocumentService, op: &Operation) -> Result<bool, ApiError> {
    let db = service.metadata.connection()?;
    let on: bool = db.query_row(
        "SELECT enabled FROM ai_configuration WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    if !on {
        return Ok(false);
    }
    if op.protocol == Protocol::Legacy {
        return Ok(true);
    }
    let Some(choice) = op.view.selection.as_ref() else {
        return Ok(false);
    };
    match check_selection(service, &db, choice, true) {
        Ok(version) => Ok(Some(version) == op.connection_version),
        Err(e) if e.status().is_client_error() => Ok(false),
        Err(e) => Err(e),
    }
}

pub(super) fn check_operation(
    service: &DocumentService,
    op: &mut Operation,
) -> Result<(), ApiError> {
    if valid(service, op)? {
        return Ok(());
    }
    if matches!(
        op.view.status,
        OperationStatus::Queued | OperationStatus::Running | OperationStatus::NeedsConfirmation
    ) && !op.recover_committed(&service.metadata)?
    {
        op.view.answer = Some("AI 配置已更改，请重新提交。".into());
        op.settle(&service.metadata, OperationStatus::Failed)?;
    }
    Err(inactive())
}

pub(super) fn check_lease(
    service: &DocumentService,
    op: &mut Operation,
    protocol: Protocol,
    instance: Option<&str>,
) -> Result<(), ApiError> {
    if op.protocol != protocol {
        return Err(ApiError::not_found());
    }
    if protocol == Protocol::Managed {
        let lease = op.lease.as_ref().ok_or_else(inactive)?;
        if lease.instance_id.as_deref() != instance {
            return Err(ApiError::not_found());
        }
        if lease.expires_at <= chrono::Utc::now().timestamp() {
            return Err(inactive());
        }
    }
    check_operation(service, op)?;
    op.actor(service, op.view.mode == Mode::Edit)?;
    Ok(())
}
fn material_lease(
    service: &DocumentService,
    headers: &HeaderMap,
    id: &str,
) -> Result<Operation, ApiError> {
    let instance = instance(service, headers)?;
    let mut op = Operation::by_lease(&service.metadata, id)?;
    check_lease(service, &mut op, Protocol::Managed, Some(&instance))?;
    super::ai_runner::require_running(&op)?;
    Ok(op)
}

pub(super) fn probe(
    service: &DocumentService,
    headers: &HeaderMap,
    lease: &str,
    action: ProbeAction<'_>,
) -> Result<Option<Value>, ApiError> {
    let instance = instance(service, headers)?;
    let db = service.metadata.connection()?;
    ai_probes::lease(service, &db, lease, &instance, action)
}

fn credential_for(
    service: &DocumentService,
    headers: &HeaderMap,
    id: &str,
    first: bool,
) -> Result<super::ai_configuration::SavedCredential, ApiError> {
    let _guard = service.metadata.ai_guard()?;
    let identity = instance(service, headers)?;
    let probe_receipt = {
        let db = service.metadata.connection()?;
        ai_probes::lease(
            service,
            &db,
            id,
            &identity,
            if first {
                ProbeAction::Provider
            } else {
                ProbeAction::CheckProvider
            },
        )?
    };
    let (connection, version) = if let Some(probe) = probe_receipt {
        let id = probe["connectionId"].as_str().ok_or_else(inactive)?;
        (
            id.to_owned(),
            probe["version"].as_i64().ok_or_else(inactive)?,
        )
    } else {
        let mut op = Operation::by_lease(&service.metadata, id)?;
        check_lease(service, &mut op, Protocol::Managed, Some(&identity))?;
        super::ai_runner::require_running(&op)?;
        let lease = op.lease.as_mut().ok_or_else(inactive)?;
        if lease.provider_issued == first {
            return Err(inactive());
        }
        if first {
            lease.provider_issued = true;
            op.store(&service.metadata, false)?;
        }
        (
            op.view.selection.ok_or_else(inactive)?.connection_id,
            op.connection_version.ok_or_else(inactive)?,
        )
    };
    let credential = saved_credential(service, &connection)?;
    if credential.version != version {
        return Err(inactive());
    }
    Ok(credential)
}

async fn provider(
    State(service): State<Arc<DocumentService>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let prepare = Arc::clone(&service);
    let (check_headers, check_id) = (headers.clone(), id.clone());
    let base = run(move || Ok(credential_for(&prepare, &check_headers, &check_id, true)?.base_url))
        .await?;
    let endpoint = service.ai_discovery.resolve_endpoint(&base).await?;
    let mut url = endpoint.base_url;
    if url.scheme() != "https" {
        return Err(ApiError::invalid("Managed provider requires HTTPS"));
    }
    let base = url.path().trim_end_matches('/');
    let root = base
        .strip_suffix("/anthropic/v1")
        .or_else(|| base.strip_suffix("/v1"))
        .unwrap_or(base);
    let path = format!("{root}/anthropic/v1/messages");
    url.set_path(&path);
    let address = endpoint.addresses.first().ok_or_else(inactive)?.ip();
    let credential = run(move || credential_for(&service, &headers, &id, false)).await?;
    let mut response=Json(json!({"messagesUrl":url.as_str(),"pinnedIp":address.to_string(),"apiKey":credential.api_key})).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

// Reconcile a recoverable commit before marking an interrupted task as failed.
pub(super) fn reconcile(service: &DocumentService, op: &mut Operation) -> Result<(), ApiError> {
    if op.external
        || !matches!(
            op.view.status,
            OperationStatus::Queued | OperationStatus::Running | OperationStatus::NeedsConfirmation
        )
    {
        return Ok(());
    }
    if op.recover_committed(&service.metadata)? {
        return Ok(());
    }
    if !valid(service, op)? {
        op.view.answer = Some("AI 配置已更改，请重新提交。".into());
    } else if op.protocol == Protocol::Managed
        && op.view.status == OperationStatus::Queued
        && op.queued_at <= chrono::Utc::now().timestamp() - 120
    {
        op.view.answer = Some("等待执行器超时，请重试。".into());
    } else {
        return Ok(());
    }
    op.settle(&service.metadata, OperationStatus::Failed)
}

// A settings change can invalidate a leased task before the next runner call.
pub(super) fn sweep(service: &DocumentService) -> Result<(), ApiError> {
    let entries = {
        let db = service.metadata.connection()?;
        let mut q=db.prepare("SELECT o.entry FROM ai_operations o JOIN ai_configuration c ON c.singleton=1
            LEFT JOIN ai_connections p ON p.id=json_extract(o.entry,'$.view.selection.connectionId')
            WHERE o.status IN ('queued','running','needs_confirmation') AND COALESCE(json_extract(o.entry,'$.external'),0)=0
            AND (c.enabled=0 OR (json_extract(o.entry,'$.runnerProtocol')='managed' AND
            (p.id IS NULL OR p.enabled=0 OR p.version!=json_extract(o.entry,'$.connectionVersion')
             OR (o.status='queued' AND json_extract(o.entry,'$.queuedAt')<=unixepoch()-120))))")?;
        let entries = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        entries
    };
    for entry in entries {
        let mut op = serde_json::from_str(&entry).map_err(ApiError::internal)?;
        reconcile(service, &mut op)?;
    }
    Ok(())
}
