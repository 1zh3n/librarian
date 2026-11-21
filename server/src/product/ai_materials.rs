pub mod segment;
mod storage;
mod tools;
pub(super) use tools::{charge_read, runner_routes, selected, Citation, Selected};

use std::{fs, io, sync::Arc};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    routing::{delete, get},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;
use uuid::Uuid;

use super::{
    ai_conversations::authorize,
    auth::Account,
    contract::ApiError,
    db::Metadata,
    documents::{run, DocumentService},
};
use segment::{Location, Segment, FILE_LIMIT};
pub(super) use storage::{sweep, unlink};

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS ai_materials(
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL,
        expires_at INTEGER NOT NULL, bound INTEGER NOT NULL DEFAULT 0, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS ai_materials_conversation ON ai_materials(conversation_id);
    CREATE TABLE IF NOT EXISTS ai_turn_materials(
        operation_id TEXT NOT NULL REFERENCES ai_turns(operation_id) ON DELETE CASCADE,
        material_id TEXT NOT NULL, PRIMARY KEY(operation_id,material_id)
    );
    CREATE TABLE IF NOT EXISTS ai_material_reads(
        operation_id TEXT NOT NULL REFERENCES ai_turns(operation_id) ON DELETE CASCADE,
        material_id TEXT NOT NULL, PRIMARY KEY(operation_id,material_id)
    );
    CREATE TABLE IF NOT EXISTS ai_lease_read_bytes(
        operation_id TEXT NOT NULL REFERENCES ai_operations(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(operation_id,lease_id)
    );")
}

pub(super) fn remove_conversation(
    tx: &Transaction<'_>,
    conversation: &str,
) -> Result<Vec<String>, ApiError> {
    let mut statement =
        tx.prepare("DELETE FROM ai_materials WHERE conversation_id=?1 RETURNING id")?;
    let ids = statement
        .query_map([conversation], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new()
        .route("/ai/conversations/{id}/materials", get(list).post(upload))
        .route(
            "/ai/conversations/{id}/materials/{material}",
            delete(remove),
        )
        .route(
            "/ai/conversations/{id}/materials/{material}/segments",
            get(catalog),
        )
        .route(
            "/ai/conversations/{id}/materials/{material}/segments/{segment}",
            get(read),
        )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterialView {
    id: String,
    name: String,
    size: i64,
    status: String,
    expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

impl MaterialView {
    fn row(r: &Row<'_>) -> rusqlite::Result<Self> {
        let mut status: String = r.get(3)?;
        if status == "working" {
            status = "parsing".into();
        }
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            size: r.get(2)?,
            status,
            expires_at: r.get(4)?,
            error_code: r.get(5)?,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upload {
    name: String,
}

fn format(name: &str, headers: &HeaderMap) -> Result<&'static str, ApiError> {
    if name.trim().is_empty()
        || name.len() > 255
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(ApiError::invalid("Invalid material filename"));
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let unsupported = || {
        ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_type",
            "File type does not match its extension",
        )
    };
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .ok_or_else(unsupported)?;
    let (kind, accepted): (&str, &[&str]) = match extension.as_str() {
        "md" => ("md", &["text/markdown", "text/plain", "text/x-markdown"]),
        "txt" => ("txt", &["text/plain"]),
        "pdf" => ("pdf", &["application/pdf"]),
        "docx" => (
            "docx",
            &["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        ),
        _ => return Err(unsupported()),
    };
    // File.type can be empty in a browser; the parser still verifies the bytes.
    if mime.is_empty() || mime == "application/octet-stream" || accepted.contains(&mime.as_str()) {
        Ok(kind)
    } else {
        Err(unsupported())
    }
}

async fn upload(
    State(service): State<Arc<DocumentService>>,
    Path(conversation): Path<String>,
    headers: HeaderMap,
    Query(query): Query<Upload>,
    body: Body,
) -> Result<(StatusCode, Json<MaterialView>), ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    authorize(&service, &account, &conversation)?;
    let kind = format(&query.name, &headers)?;
    let too_large = || {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "Maximum material size is 10 MiB",
        )
    };
    if headers
        .get(header::CONTENT_LENGTH)
        .and_then(|s| s.to_str().ok()?.parse::<u64>().ok())
        .is_some_and(|size| size > FILE_LIMIT as u64)
    {
        return Err(too_large());
    }
    let dir = storage::directory(&service.metadata)?;
    let tmp = tempfile::Builder::new()
        .prefix(".upload-")
        .tempfile_in(&dir)
        .map_err(ApiError::internal)?;
    let mut file = tokio::fs::File::from_std(tmp.reopen().map_err(ApiError::internal)?);
    let mut stream = body.into_data_stream();
    let mut size = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::invalid("Material upload interrupted"))?;
        if chunk.len() > FILE_LIMIT - size {
            return Err(too_large());
        }
        size += chunk.len();
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    file.sync_all().await.map_err(ApiError::internal)?;
    drop(file);
    let size = size as i64;
    let store = service.clone();
    let material = run(move || {
        let _guard = store.metadata.ai_guard()?;
        authorize(&store, &account, &conversation)?;
        let id = Uuid::new_v4().simple().to_string();
        let expires_at = storage::now() + storage::DRAFT_TTL;
        let mut conn = store.metadata.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_materials(id,conversation_id,name,format,size,status,expires_at)
             VALUES (?1,?2,?3,?4,?5,'parsing',?6)",
            params![id, conversation, query.name, kind, size, expires_at],
        )?;
        tmp.persist_noclobber(dir.join(format!("{id}.raw")))
            .map_err(ApiError::internal)?;
        #[cfg(unix)]
        fs::File::open(&dir)
            .and_then(|f| f.sync_all())
            .map_err(ApiError::internal)?;
        tx.commit()?;
        Ok(MaterialView {
            id,
            name: query.name,
            size,
            status: "parsing".into(),
            expires_at,
            error_code: None,
        })
    })
    .await?;
    storage::kick(&service);
    Ok((StatusCode::ACCEPTED, Json(material)))
}

async fn list(
    State(service): State<Arc<DocumentService>>,
    Path(conversation): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<MaterialView>>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        authorize(&service, &account, &conversation)?;
        let conn = service.metadata.connection()?;
        let mut stmt = conn.prepare(
            "SELECT id,name,size,status,expires_at,error_code FROM ai_materials
             WHERE conversation_id=?1 AND expires_at>?2 ORDER BY rowid",
        )?;
        let items = stmt
            .query_map(params![conversation, storage::now()], MaterialView::row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Json(items))
    })
    .await
}

async fn remove(
    State(service): State<Arc<DocumentService>>,
    Path((conversation, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let a = Account::authenticate(&service.spaces, &headers, true)?;
    run(move || {
        let db = &service.metadata;
        let _guard = db.ai_guard()?;
        authorize(&service, &a, &conversation)?;
        if db.connection()?.execute(
            "DELETE FROM ai_materials WHERE conversation_id=?1 AND id=?2",
            params![conversation, id],
        )? == 0
        {
            return Err(ApiError::not_found());
        }
        storage::unlink(db, &id)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Search {
    pub q: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SegmentPage {
    items: Vec<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

fn ready(
    conn: &Connection,
    conversation: &str,
    id: &str,
    now: i64,
) -> Result<(String, i64), ApiError> {
    let (name, size, status): (String, i64, String) = conn
        .query_row(
            "SELECT name,size,status FROM ai_materials
         WHERE conversation_id=?1 AND id=?2 AND expires_at>?3",
            params![conversation, id, now],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(ApiError::not_found)?;
    if status != "ready" {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "material_not_ready",
            "Wait for a ready material",
        ));
    }
    Ok((name, size))
}

fn load(
    db: &Metadata,
    con: &Connection,
    conversation: &str,
    id: &str,
) -> Result<(String, Vec<Segment>), ApiError> {
    let (name, _) = ready(con, conversation, id, storage::now())?;
    // id has been matched to a server-generated database row.
    let f = fs::File::open(storage::directory(db)?.join(format!("{id}.json"))).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            ApiError::not_found()
        } else {
            ApiError::internal(e)
        }
    })?;
    Ok((
        name,
        serde_json::from_reader(f).map_err(ApiError::internal)?,
    ))
}

fn page(segments: Vec<Segment>, query: Search) -> Result<SegmentPage, ApiError> {
    const PAGE: usize = 24;
    let offset = query
        .cursor
        .as_deref()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| ApiError::invalid("Invalid segment cursor"))?;
    if offset > segments.len() {
        return Err(ApiError::invalid("Invalid segment cursor"));
    }
    let needle = query.q.as_deref().unwrap_or("").trim();
    if needle.len() > 512 {
        return Err(ApiError::invalid("Maximum search query is 512 bytes"));
    }
    let needle = needle.to_lowercase();
    let mut hits = segments
        .into_iter()
        .enumerate()
        .skip(offset)
        .filter(|(_, s)| needle.is_empty() || s.text.to_lowercase().contains(&needle));
    let items = hits.by_ref().take(PAGE).map(|(_, s)| s.location).collect();
    let next_cursor = hits.next().map(|(index, _)| index.to_string());
    Ok(SegmentPage { items, next_cursor })
}

async fn catalog(
    State(service): State<Arc<DocumentService>>,
    Path((conversation, id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(search): Query<Search>,
) -> Result<Json<SegmentPage>, ApiError> {
    let a = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        authorize(&service, &a, &conversation)?;
        let (_, segments) = load(
            &service.metadata,
            &*service.metadata.connection()?,
            &conversation,
            &id,
        )?;
        page(segments, search).map(Json)
    })
    .await
}

async fn read(
    State(service): State<Arc<DocumentService>>,
    Path((conversation, id, segment)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Segment>, ApiError> {
    let a = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || {
        authorize(&service, &a, &conversation)?;
        let (_, segments) = load(
            &service.metadata,
            &*service.metadata.connection()?,
            &conversation,
            &id,
        )?;
        segments
            .into_iter()
            .find(|s| s.location.segment_id == segment)
            .map(Json)
            .ok_or_else(ApiError::not_found)
    })
    .await
}

/// Called inside the transaction that creates the turn, after its row exists.
pub(super) fn bind_turn(
    tx: &Transaction<'_>,
    conversation: &str,
    operation: &str,
    ids: &[String],
) -> Result<(), ApiError> {
    const BATCH_BYTES: i64 = 25 * 1024 * 1024;
    if ids.is_empty() {
        return Ok(());
    }
    let managed: bool = tx.query_row(
        "SELECT mode='managed' FROM ai_configuration WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    if !managed {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "managed_activation_required",
            "Activate managed AI to analyze selected materials",
        ));
    }
    if ids.len() > 5 {
        return Err(ApiError::invalid("Select up to five materials per turn"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    let now = storage::now();
    for id in ids {
        if !seen.insert(id) {
            return Err(ApiError::invalid("Duplicate material selection"));
        }
        let (_, size) = ready(tx, conversation, id, now)?;
        total += size;
        if total > BATCH_BYTES {
            return Err(ApiError::invalid("Selected materials exceed 25 MiB"));
        }
        tx.execute(
            "UPDATE ai_materials SET bound=1,expires_at=?2 WHERE id=?1 AND bound=0",
            params![id, now + storage::BOUND_TTL],
        )?;
        tx.execute(
            "INSERT INTO ai_turn_materials(operation_id,material_id) VALUES (?1,?2)",
            params![operation, id],
        )?;
    }
    Ok(())
}
