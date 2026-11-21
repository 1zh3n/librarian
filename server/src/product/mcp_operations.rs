use super::{
    ai::{AcceptedResult, Operation, OperationStatus},
    ai_reorganization::{self, ReorganizationRequest, WorkspaceEdit},
    auth::Account,
    contract::ApiError,
    documents::DocumentService,
    imports,
};
use crate::auth::mcp::grants::Grant;
use axum::http::StatusCode;
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use silverbullet_server_common::revision::sha256_hex;
use uuid::Uuid;

pub(super) fn live_grant(
    service: &DocumentService,
    username: &str,
    id: &str,
) -> Result<Grant, ApiError> {
    service
        .spaces
        .grants
        .get_live(id, chrono::Utc::now().timestamp() as u64)
        .filter(|g| {
            g.username == username
                && service
                    .spaces
                    .users
                    .session_is_current(username, g.credential_version.as_deref())
        })
        .ok_or_else(ApiError::not_found)
}

struct Origin {
    client: String,
    grant: String,
    owner: String,
    workspace: String,
    digest: String,
    kind: String,
    undo: String,
}

fn origin(service: &DocumentService, id: &str) -> Result<Option<Origin>, ApiError> {
    Ok(service.metadata.connection()?.query_row(
        "SELECT client_id,grant_id,owner,workspace_id,request_digest,kind,undo_id FROM mcp_operation_origins WHERE operation_id=?1",
        [id],|r|Ok(Origin{client:r.get(0)?,grant:r.get(1)?,owner:r.get(2)?,workspace:r.get(3)?,digest:r.get(4)?,kind:r.get(5)?,undo:r.get(6)?})).optional()?)
}

fn check_grant(
    service: &DocumentService,
    grant: &Grant,
    workspace: &str,
    write: bool,
) -> Result<(), ApiError> {
    if (write && grant.access != "write")
        || !grant
            .spaces
            .contains(&service.metadata.space_id(workspace)?)
    {
        return Err(ApiError::not_found());
    }
    Ok(())
}

pub(super) fn check_original(
    service: &DocumentService,
    op: &Operation,
    actor: &str,
    write: bool,
) -> Result<(), ApiError> {
    if !op.external {
        return Ok(());
    }
    let bound = origin(service, &op.view.id)?.ok_or_else(ApiError::not_found)?;
    let grant = live_grant(service, actor, &bound.grant)?;
    if bound.owner != actor
        || bound.workspace != op.view.workspace_id
        || bound.client != grant.client_id
    {
        return Err(ApiError::not_found());
    }
    check_grant(service, &grant, &bound.workspace, write)
}

enum Command {
    Apply(Vec<WorkspaceEdit>),
    Reorganize(ReorganizationRequest),
    Upload(imports::ImportRequest),
    Get,
    Undo,
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value)
        .map_err(|_| ApiError::invalid("Invalid workspace operation arguments"))
}

impl Command {
    fn parse(name: &str, mut args: Value) -> Result<(String, String, Self), ApiError> {
        let bad = || ApiError::invalid("Invalid workspace operation arguments");
        let obj = args.as_object_mut().ok_or_else(bad)?;
        let workspace = parse(obj.remove("workspaceId").ok_or_else(bad)?)?;
        let id: String = parse(obj.remove("operationId").ok_or_else(bad)?)?;
        if Uuid::parse_str(&id)
            .ok()
            .is_none_or(|u| u.to_string() != id)
        {
            return Err(bad());
        }
        let cmd = match name {
            "workspace_apply_edits" => Self::Apply(parse(obj.remove("edits").ok_or_else(bad)?)?),
            "workspace_request_reorganization" => {
                Self::Reorganize(parse(obj.remove("request").ok_or_else(bad)?)?)
            }
            "workspace_get_operation" => Self::Get,
            "workspace_undo_operation" => Self::Undo,
            "workspace_upload_files"
                if obj.get("files").is_some_and(Value::is_array)
                    && !obj.contains_key("archiveBase64") =>
            {
                obj.insert("operationId".into(), json!(id));
                return Ok((workspace, id, Self::Upload(parse(args)?)));
            }
            _ => return Err(bad()),
        };
        if !obj.is_empty() {
            return Err(bad());
        }
        Ok((workspace, id, cmd))
    }
}

fn changed() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "operation_id_reused",
        "The operation ID is already bound to another request",
    )
}

pub(super) fn call(
    service: &DocumentService,
    account: &Account,
    grant: &Grant,
    name: &str,
    mut args: Value,
) -> Result<Value, ApiError> {
    args.sort_all_objects();
    let digest = sha256_hex(&serde_json::to_vec(&(name, &args)).map_err(ApiError::internal)?);
    let (ws, id, cmd) = Command::parse(name, args)?;
    let _guard = service.metadata.ai_guard()?;
    let grant = live_grant(service, account.username(), &grant.id)?;
    let write = !matches!(cmd, Command::Get);
    check_grant(service, &grant, &ws, write)?;
    service.scope(account, &ws, write)?;
    let read_receipt = matches!(cmd, Command::Get | Command::Undo);
    let prior = origin(service, &id)?;
    if let Some(bound) = &prior {
        if bound.workspace != ws
            || bound.owner != account.username()
            || bound.grant != grant.id
            || bound.client != grant.client_id
        {
            return Err(ApiError::not_found());
        }
        if !read_receipt && bound.digest != digest {
            return Err(changed());
        }
    } else {
        if read_receipt {
            return Err(ApiError::not_found());
        }
        let db = service.metadata.connection()?;
        let inserted=db.execute("INSERT INTO mcp_operation_origins(operation_id,workspace_id,owner,client_id,grant_id,request_digest,kind,undo_id)
            SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE NOT EXISTS(SELECT 1 FROM ai_operations WHERE id=?1)
            AND NOT EXISTS(SELECT 1 FROM mutations WHERE operation_id=?1)",
            params![id,ws,account.username(),grant.client_id,grant.id,digest,name,Uuid::new_v4().to_string()])?;
        if inserted == 0 {
            return Err(changed());
        }
    }
    if let Command::Upload(upload) = cmd {
        return imports::import(service, account, &ws, upload);
    }
    if let Some(bound) = prior
        .as_ref()
        .filter(|b| b.kind == "workspace_upload_files")
    {
        return imports::operation(
            service,
            account,
            &ws,
            &id,
            matches!(cmd, Command::Undo).then_some(bound.undo.as_str()),
        );
    }
    let mut op = match Operation::get(&service.metadata, &id) {
        Ok(mut op) => {
            op.ensure_owner(service, account, write)?;
            if matches!(cmd, Command::Undo) {
                op.undo(service, account)?;
            } else if matches!(cmd, Command::Apply(_))
                && op.view.status == OperationStatus::Running
                && op.accepted.is_some()
            {
                op.apply_result(service, account)?;
            }
            return Ok(view(service, &op));
        }
        Err(e) if e.status() == StatusCode::NOT_FOUND && !read_receipt => {
            Operation::new_edit(service, account, &ws, &id)?
        }
        Err(e) => return Err(e),
    };
    match cmd {
        Command::Apply(edits) => {
            let edits = ai_reorganization::resolve_edits(service, &ws, edits, None)?;
            op.accepted = Some(AcceptedResult {
                answer: String::new(),
                sources: Vec::new(),
                edits,
            });
            op.store(&service.metadata, false)?;
            op.apply_result(service, account)?;
        }
        Command::Reorganize(request) => {
            ai_reorganization::preview(service, account, &mut op, request)?
        }
        _ => return Err(ApiError::not_found()),
    }
    Ok(view(service, &op))
}

fn view(service: &DocumentService, op: &Operation) -> Value {
    let mut result = json!(op.view);
    if let Some(documents) = result
        .pointer_mut("/writeResult/documents")
        .and_then(Value::as_array_mut)
    {
        for doc in documents {
            if let Some(path) = doc["readerPath"].as_str() {
                let link = service.reader_links.link(path.to_owned());
                doc["readerUrl"] = json!(link.reader_url);
                if let Some(error) = link.reader_url_error {
                    doc["readerUrlError"] = json!(error)
                }
            }
        }
    }
    let link = service.reader_links.link(format!(
        "/workspaces/{}/ai?operationId={}",
        op.view.workspace_id, op.view.id
    ));
    result
        .as_object_mut()
        .unwrap()
        .extend(json!(link).as_object().unwrap().clone());
    result
}
