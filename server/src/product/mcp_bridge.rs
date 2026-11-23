use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::http::{HeaderMap, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    audit,
    auth::Account,
    content_policy::{self, Action},
    contract::{content_precondition, present_revision, ApiError},
    documents::{
        check_file_path, is_document_path, outline_path, run, state, DocumentList, DocumentService,
    },
    mutations::{MutationContext, MutationEdit, MutationReceipt},
    revisions::{self, HistoryQuery},
    search,
    security_levels::SecurityLevel,
    space_adapter::NativeSpaces,
    workspace,
};

const MAX_RATE_KEYS: usize = 4096;
const RATE_WINDOW_SECS: u64 = 60;
const READ_LIMIT: u32 = 120;
const WRITE_LIMIT: u32 = 30;
const UPLOAD_LIMIT: u32 = 10;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum RateClass {
    Read,
    Write,
    Upload,
}

impl RateClass {
    fn limit(self) -> u32 {
        match self {
            Self::Read => READ_LIMIT,
            Self::Write => WRITE_LIMIT,
            Self::Upload => UPLOAD_LIMIT,
        }
    }
}

#[derive(Clone, Copy)]
struct RateBucket {
    window: u64,
    count: u32,
}

#[derive(Default)]
struct McpRateLimits {
    buckets: Mutex<HashMap<(String, RateClass), RateBucket>>,
}

impl McpRateLimits {
    fn check(&self, grant: &str, class: RateClass, now: u64) -> Option<u64> {
        let Ok(mut buckets) = self.buckets.lock() else {
            return Some(RATE_WINDOW_SECS);
        };
        let window = now / RATE_WINDOW_SECS;
        if buckets.len() >= MAX_RATE_KEYS {
            buckets.retain(|_, bucket| bucket.window == window);
            if buckets.len() >= MAX_RATE_KEYS && !buckets.contains_key(&(grant.to_owned(), class)) {
                return Some(RATE_WINDOW_SECS);
            }
        }
        let bucket = buckets
            .entry((grant.to_owned(), class))
            .or_insert(RateBucket { window, count: 0 });
        if bucket.window != window {
            bucket.window = window;
            bucket.count = 0;
        }
        if bucket.count >= class.limit() {
            return Some(RATE_WINDOW_SECS - now % RATE_WINDOW_SECS);
        }
        bucket.count = bucket.count.saturating_add(1);
        None
    }
}

/// Product tool adapter for the Librarian MCP server. The caller supplies the
/// identity and spaces from an OAuth grant validated for the current request.
pub struct McpBridge {
    service: Arc<DocumentService>,
    limits: McpRateLimits,
}

impl McpBridge {
    pub(super) fn new(service: Arc<DocumentService>) -> Self {
        Self {
            service,
            limits: McpRateLimits::default(),
        }
    }

    pub fn spaces(&self) -> &NativeSpaces {
        &self.service.spaces
    }

    pub async fn call(
        &self,
        username: &str,
        grant_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, Value> {
        let workspace = tool_workspace(&self.service, name, &arguments)
            .ok()
            .flatten();
        let result = self.dispatch(username, grant_id, name, arguments).await;
        let (outcome, rule) = match &result {
            Ok(_) => ("ok", None),
            Err(error) => ("error", error.rule_id()),
        };
        let details = json!({ "grantId": grant_id });
        if let Err(error) = audit::record(
            &self.service.metadata,
            audit::Event {
                actor: Some(username),
                workspace: workspace.as_deref(),
                action: "mcp.tool.call",
                target: Some(name),
                result: outcome,
                rule_id: rule,
                request_id: None,
                metadata: Some(&details),
            },
        ) {
            tracing::warn!(?error, "could not record MCP tool call");
        }
        result.map_err(ApiError::payload)
    }

    async fn dispatch(
        &self,
        username: &str,
        grant_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, ApiError> {
        // Authenticate before revealing whether a workspace is restricted.
        let grant = super::mcp_operations::live_grant(&self.service, username, grant_id)?;
        Account::from_bound_identity(
            self.spaces(),
            username,
            grant.credential_version.as_deref(),
            grant.spaces.iter().cloned().collect(),
        )?;
        let service = self.service.clone();
        let target_workspace = tool_workspace(&service, name, &arguments).ok().flatten();
        if let Some(retry) = self.limits.check(&grant.id, classify(name), now_secs()) {
            audit::rate_limited(
                &service.metadata,
                Some(username),
                target_workspace.as_deref(),
                "mcp",
                retry,
            )?;
            return Err(ApiError::rate_limited(retry));
        }

        if name == "workspace_list" {
            let mut result = self
                .dispatch_inner(username, grant_id, name, arguments)
                .await?;
            filter_workspace_list(&mut result);
            return Ok(result);
        }

        let Some(workspace) = target_workspace else {
            return self
                .dispatch_inner(username, grant_id, name, arguments)
                .await;
        };
        let level = workspace::info(&service.metadata, &workspace)?.security_level;
        if matches!(level, SecurityLevel::Confidential | SecurityLevel::Secret) {
            audit::policy_block(
                &service.metadata,
                Some(username),
                &workspace,
                "mcp",
                "external_mcp_disabled",
            )?;
            return Err(ApiError::policy_blocked("external_mcp_disabled"));
        }
        if name == "workspace_publish" && level != SecurityLevel::Public {
            audit::policy_block(
                &service.metadata,
                Some(username),
                &workspace,
                "mcp",
                "publication_requires_public_workspace",
            )?;
            return Err(ApiError::policy_blocked(
                "publication_requires_public_workspace",
            ));
        }

        let arguments = if read_tool(name) {
            arguments
        } else {
            let mut scanned = arguments;
            if let Some(rule) = scan_value(&mut scanned, level, false) {
                audit::policy_block(&service.metadata, Some(username), &workspace, "mcp", rule)?;
                return Err(ApiError::policy_blocked(rule));
            }
            scanned
        };

        let mut result = self
            .dispatch_inner(username, grant_id, name, arguments)
            .await?;
        if !skip_scan_tool(name) {
            if let Some(rule) = scan_value(&mut result, level, true) {
                audit::policy_block(&service.metadata, Some(username), &workspace, "mcp", rule)?;
                return Err(ApiError::policy_blocked(rule));
            }
        }
        Ok(result)
    }

    async fn dispatch_inner(
        &self,
        username: &str,
        grant_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, ApiError> {
        let grant = super::mcp_operations::live_grant(&self.service, username, grant_id)?;
        let account = Account::from_bound_identity(
            self.spaces(),
            username,
            grant.credential_version.as_deref(),
            grant.spaces.iter().cloned().collect(),
        )?;
        let service = self.service.clone();
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

fn tool_workspace(
    service: &DocumentService,
    name: &str,
    arguments: &Value,
) -> Result<Option<String>, ApiError> {
    if name == "workspace_list" {
        return Ok(None);
    }
    if let Some(workspace) = arguments.get("workspaceId").and_then(Value::as_str) {
        return Ok(Some(workspace.to_owned()));
    }
    if let Some(document) = arguments.get("documentId").and_then(Value::as_str) {
        return Ok(Some(service.metadata.document_path(document)?.0));
    }
    Ok(None)
}

fn read_tool(name: &str) -> bool {
    matches!(
        name,
        "workspace_read_asset"
            | "workspace_list_assets"
            | "workspace_get_operation"
            | "workspace_list"
            | "document_list"
            | "document_read"
            | "document_search"
            | "document_outline_read"
            | "revision_list"
            | "revision_diff"
    )
}

fn classify(name: &str) -> RateClass {
    if matches!(name, "workspace_upload_files" | "workspace_upload_image") {
        RateClass::Upload
    } else if read_tool(name) {
        RateClass::Read
    } else {
        RateClass::Write
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn skip_scan_tool(name: &str) -> bool {
    matches!(name, "workspace_read_asset" | "workspace_list_assets")
}

fn binary_key(key: &str) -> bool {
    matches!(
        key,
        "contentBase64" | "imageBase64" | "data" | "base64" | "bytes"
    )
}

fn content_key(key: &str) -> bool {
    matches!(
        key,
        "markdown"
            | "answer"
            | "excerpt"
            | "text"
            | "content"
            | "body"
            | "snippet"
            | "title"
            | "name"
            | "diff"
    )
}

fn scan_value(value: &mut Value, level: SecurityLevel, redact: bool) -> Option<&'static str> {
    scan_strings(value, level, redact, true)
}

fn scan_strings(
    value: &mut Value,
    level: SecurityLevel,
    redact: bool,
    scan: bool,
) -> Option<&'static str> {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if binary_key(key) {
                    continue;
                }
                if let Some(rule) = scan_strings(item, level, redact, content_key(key)) {
                    return Some(rule);
                }
            }
            None
        }
        Value::Array(items) => {
            for item in items {
                if let Some(rule) = scan_strings(item, level, redact, scan) {
                    return Some(rule);
                }
            }
            None
        }
        Value::String(text) if scan => {
            let inspection = content_policy::inspect(text, level);
            match inspection.action {
                Action::Allow => None,
                Action::Deny => Some(inspection.blocking_rule.unwrap_or("content_policy")),
                Action::Redact if redact => {
                    *text = inspection.redacted;
                    None
                }
                Action::Redact => inspection
                    .findings
                    .first()
                    .map(|finding| finding.rule)
                    .or(Some("content_policy")),
            }
        }
        _ => None,
    }
}

fn filter_workspace_list(result: &mut Value) {
    let Some(workspaces) = result.get_mut("workspaces").and_then(Value::as_array_mut) else {
        return;
    };
    workspaces.retain(|workspace| {
        workspace
            .get("securityLevel")
            .and_then(Value::as_str)
            .is_none_or(|level| matches!(level, "public" | "internal"))
    });
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

#[cfg(test)]
mod rate_tests {
    use super::{classify, McpRateLimits, RateClass, RATE_WINDOW_SECS};

    #[test]
    fn read_bucket_blocks_after_its_limit_and_isolates_grants() {
        let limits = McpRateLimits::default();
        let now = 1_000_000;
        for _ in 0..120 {
            assert_eq!(limits.check("grant-a", RateClass::Read, now), None);
        }
        assert_eq!(
            limits.check("grant-a", RateClass::Read, now),
            Some(20),
            "the window ends 20 seconds after the sample instant"
        );
        assert_eq!(limits.check("grant-b", RateClass::Read, now), None);
        assert_eq!(limits.check("grant-a", RateClass::Write, now), None);
        assert_eq!(
            limits.check("grant-a", RateClass::Read, now + RATE_WINDOW_SECS),
            None
        );
    }

    #[test]
    fn upload_bucket_has_its_own_smaller_limit() {
        let limits = McpRateLimits::default();
        let now = 60;
        for _ in 0..10 {
            assert_eq!(limits.check("grant", RateClass::Upload, now), None);
        }
        assert!(limits.check("grant", RateClass::Upload, now).is_some());
    }

    #[test]
    fn tool_names_map_to_the_expected_bucket() {
        assert!(matches!(classify("document_read"), RateClass::Read));
        assert!(matches!(classify("workspace_list"), RateClass::Read));
        assert!(matches!(
            classify("workspace_upload_image"),
            RateClass::Upload
        ));
        assert!(matches!(classify("document_update"), RateClass::Write));
        assert!(matches!(
            classify("workspace_request_reorganization"),
            RateClass::Write
        ));
    }
}
