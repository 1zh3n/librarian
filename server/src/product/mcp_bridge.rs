use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    auth::Account,
    contract::{content_precondition, present_revision, ApiError},
    documents::{
        check_file_path, is_document_path, outline_path, run, state, DocumentList, DocumentService,
    },
    mutations::{MutationContext, MutationEdit, MutationReceipt},
    revisions::{self, HistoryQuery},
    search,
    space_adapter::NativeSpaces,
};

/// Product tool adapter for the Librarian MCP server. The caller supplies the
/// identity and spaces from an OAuth grant validated for the current request.
pub struct McpBridge(Arc<DocumentService>);

impl McpBridge {
    pub(super) fn new(service: Arc<DocumentService>) -> Self {
        Self(service)
    }

    pub fn spaces(&self) -> &NativeSpaces {
        &self.0.spaces
    }

    pub async fn call(
        &self,
        username: &str,
        grant_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, Value> {
        self.dispatch(username, grant_id, name, arguments)
            .await
            .map_err(ApiError::payload)
    }

    async fn dispatch(
        &self,
        username: &str,
        grant_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, ApiError> {
        let grant = super::mcp_operations::live_grant(&self.0, username, grant_id)?;
        let account = Account::from_bound_identity(
            self.spaces(),
            username,
            grant.credential_version.as_deref(),
            grant.spaces.iter().cloned().collect(),
        )?;
        let service = self.0.clone();
        if name == "workspace_read_asset" {
            let args: AssetReadArgs = arguments_as(arguments)?;
            return super::assets::read_asset(&service, &account, &args.workspace_id, &args.path);
        }
        if name == "workspace_list_assets" {
            let args: AssetListArgs = arguments_as(arguments)?;
            return super::assets::list_assets(
                &service,
                &account,
                &args.workspace_id,
                args.directory.as_deref().unwrap_or(""),
                args.after.as_deref(),
                args.limit,
            );
        }
        if name == "document_search" {
            let args: SearchArgs = arguments_as(arguments)?;
            let hits = search::find_documents(
                service,
                account,
                args.workspace_id,
                args.query,
                &HeaderMap::new(),
            )
            .await?;
            return Ok(json!({"hits": hits}));
        }
        let name = name.to_owned();
        run(move || match name.as_str() {
            "workspace_apply_edits"
            | "workspace_request_reorganization"
            | "workspace_get_operation"
            | "workspace_undo_operation"
            | "workspace_upload_files"
            | "workspace_upload_image" => {
                super::mcp_operations::call(&service, &account, &grant, &name, arguments)
            }
            _ => call_local(&service, &account, &name, arguments),
        })
        .await
    }
}

fn arguments_as<T: DeserializeOwned>(arguments: Value) -> Result<T, ApiError> {
    serde_json::from_value(arguments).map_err(|_| ApiError::invalid("Invalid tool arguments"))
}

fn encode(value: impl Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(ApiError::internal)
}

fn call_local(
    service: &DocumentService,
    account: &Account,
    name: &str,
    arguments: Value,
) -> Result<Value, ApiError> {
    match name {
        "publication_request" => encode(super::publication::request_proposal(
            service,
            account,
            arguments_as(arguments)?,
        )?),
        "workspace_publish" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct PublishArgs {
                workspace_id: String,
                delivery: super::delivery::DeliveryRequest,
            }
            let args: PublishArgs = arguments_as(arguments)?;
            encode(super::delivery::publish(
                service,
                account,
                &args.workspace_id,
                args.delivery,
            )?)
        }
        "workspace_list" => {
            let _: EmptyArgs = arguments_as(arguments)?;
            Ok(json!({"workspaces": service.workspaces(account)?}))
        }
        "document_list" => {
            let args: ListArgs = arguments_as(arguments)?;
            let query = DocumentList {
                after: args.after,
                limit: args.limit,
            };
            let documents = service.list(account, &args.workspace_id, query)?;
            Ok(json!({"documents": documents}))
        }
        "document_read" => {
            let args: DocumentArgs = arguments_as(arguments)?;
            encode(service.get(account, &args.document_id)?)
        }
        "document_outline_read" => {
            let args: DocumentArgs = arguments_as(arguments)?;
            encode(service.get_outline(account, &args.document_id)?)
        }
        "revision_list" => {
            let args: HistoryArgs = arguments_as(arguments)?;
            let query = HistoryQuery {
                before: args.before,
                limit: args.limit,
            };
            encode(revisions::document_history(
                service,
                account,
                &args.document_id,
                query,
            )?)
        }
        "revision_diff" => {
            let args: DiffArgs = arguments_as(arguments)?;
            encode(revisions::document_diff(
                service,
                account,
                &args.document_id,
                args.commit_id,
            )?)
        }
        "document_create" => {
            let args: CreateArgs = arguments_as(arguments)?;
            if !is_document_path(&args.path) {
                return Err(ApiError::invalid(
                    "Expected a relative Markdown document path",
                ));
            }
            let change = Change::Markdown(args.markdown, None);
            write(
                service,
                account,
                &args.workspace_id,
                &args.operation_id,
                WriteTarget::NewPath(args.path),
                change,
            )
        }
        "document_update" | "document_outline_update" => {
            let args: UpdateArgs = arguments_as(arguments)?;
            let base = content_precondition(args.base_revision.as_ref())?.map(str::to_owned);
            let change = if name == "document_outline_update" {
                Change::Outline(args.markdown, base)
            } else {
                let base =
                    base.ok_or_else(|| ApiError::invalid("Updating requires a content revision"))?;
                Change::Markdown(args.markdown, Some(base))
            };
            let (workspace, _) = service.metadata.document_path(&args.document_id)?;
            write(
                service,
                account,
                &workspace,
                &args.operation_id,
                WriteTarget::Document(args.document_id),
                change,
            )
        }
        "revision_restore" => {
            let args: RestoreArgs = arguments_as(arguments)?;
            let base = content_precondition(args.base_revision.as_ref())?
                .ok_or_else(|| ApiError::invalid("Restoring requires a content revision"))?;
            revisions::validate_commit(&args.commit_id)?;
            let (workspace, _) = service.metadata.document_path(&args.document_id)?;
            let change = Change::Restore(args.commit_id, base.to_owned());
            write(
                service,
                account,
                &workspace,
                &args.operation_id,
                WriteTarget::Document(args.document_id),
                change,
            )
        }
        _ => Err(ApiError::invalid("Unknown Librarian tool")),
    }
}

enum Change {
    Markdown(String, Option<String>),
    Outline(String, Option<String>),
    Restore(String, String),
}

enum WriteTarget {
    NewPath(String),
    Document(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteResult {
    document_id: String,
    path: String,
    #[serde(flatten)]
    link: super::reader_links::ReaderLink,
    #[serde(flatten)]
    receipt: MutationReceipt,
}

fn write(
    service: &DocumentService,
    account: &Account,
    workspace: &str,
    operation: &str,
    target_document: WriteTarget,
    change: Change,
) -> Result<Value, ApiError> {
    let (instance, actor) = service.scope(account, workspace, true)?;
    let state = state(&instance)?;
    let engine = state
        .revisions
        .as_deref()
        .filter(|engine| engine.store().auto_commit_allowed())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "revisions_read_only",
                "Writes require managed versions in this workspace",
            )
        })?;
    let result = engine.with_managed_write(|transaction| -> Result<WriteResult, ApiError> {
        let path = match target_document {
            WriteTarget::NewPath(ref path) => path.clone(),
            WriteTarget::Document(ref document) => service.path_in(workspace, document)?,
        };
        let (target, markdown, base_revision) = match change {
            Change::Markdown(markdown, base) => (path.clone(), markdown, base),
            Change::Outline(markdown, base) => {
                check_file_path(state, &path)?;
                state.space.get_file_meta(&path)?;
                (outline_path(&path), markdown, base)
            }
            Change::Restore(commit, base) => {
                let WriteTarget::Document(ref document) = target_document else {
                    return Err(ApiError::invalid("Restoring a version requires a document"));
                };
                let markdown = revisions::historical_markdown(
                    service, engine, workspace, document, &path, &commit,
                )?
                .ok_or_else(ApiError::not_found)?;
                (path.clone(), markdown, Some(base))
            }
        };
        let receipt = MutationContext {
            metadata: &service.metadata,
            state,
            actor: &actor,
            workspace,
            account: account.username(),
            operation,
        }
        .apply(
            transaction,
            vec![MutationEdit {
                path: target,
                base_revision,
                markdown: Some(markdown),
            }],
        )?;
        let document_id = service.metadata.document_id(workspace, &path)?;
        Ok(WriteResult {
            link: service.reader_links.document(workspace, &document_id),
            path,
            document_id,
            receipt,
        })
    })?;
    encode(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetReadArgs {
    workspace_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetListArgs {
    workspace_id: String,
    directory: Option<String>,
    after: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    workspace_id: String,
    after: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentArgs {
    document_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchArgs {
    workspace_id: String,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateArgs {
    workspace_id: String,
    operation_id: String,
    path: String,
    markdown: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateArgs {
    document_id: String,
    operation_id: String,
    #[serde(default, deserialize_with = "present_revision")]
    base_revision: Option<Option<String>>,
    markdown: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryArgs {
    document_id: String,
    before: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffArgs {
    document_id: String,
    commit_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreArgs {
    document_id: String,
    operation_id: String,
    #[serde(default, deserialize_with = "present_revision")]
    base_revision: Option<Option<String>>,
    commit_id: String,
}
