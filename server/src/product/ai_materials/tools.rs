use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
    Extension, Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{load, page, segment::Location, storage, Search, SegmentPage};
use crate::product::{
    ai::Operation,
    contract::ApiError,
    db::Metadata,
    documents::{run, DocumentService},
};
use axum::http::StatusCode;

type AuthenticateLease = fn(&DocumentService, &HeaderMap, &str) -> Result<Operation, ApiError>;

/// A3 supplies its instance/protocol/lease/version validator. Both material
/// endpoints run validation and delivery inside the same gate as cancel/result.
pub(in crate::product) fn runner_routes(
    authorize: AuthenticateLease,
) -> Router<Arc<DocumentService>> {
    Router::new()
        .route(
            "/ai/runner/v2/claims/{lease}/materials/{material}/segments",
            get(list_segments),
        )
        .route(
            "/ai/runner/v2/claims/{lease}/materials/{material}/segments/{segment}",
            get(read_segment),
        )
        .layer(Extension(authorize))
}

async fn list_segments(
    State(service): State<Arc<DocumentService>>,
    Extension(auth): Extension<AuthenticateLease>,
    Path((lease, id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(search): Query<Search>,
) -> Result<Json<SegmentPage>, ApiError> {
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let op = auth(&service, &headers, &lease)?;
        leased_list(&service, &op, &id, search).map(Json)
    })
    .await
}

async fn read_segment(
    State(service): State<Arc<DocumentService>>,
    Extension(auth): Extension<AuthenticateLease>,
    Path((lease, id, sid)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<ReadSource>, ApiError> {
    run(move || {
        let _guard = service.metadata.ai_guard()?;
        let mut op = auth(&service, &headers, &lease)?;
        leased_read(&service, &mut op, &id, &sid).map(Json)
    })
    .await
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::product) enum MaterialKind {
    Material,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::product) struct Citation {
    kind: MaterialKind,
    conversation_id: String,
    material_id: String,
    name: String,
    #[serde(flatten)]
    location: Location,
}

#[derive(Serialize)]
pub(in crate::product) struct Selected {
    id: String,
    name: String,
}

pub(in crate::product) fn selected(
    db: &Metadata,
    operation: &str,
) -> Result<Vec<Selected>, ApiError> {
    let conn = db.connection()?;
    let mut q = conn.prepare(
        "SELECT m.id,m.name FROM ai_turn_materials tm
        JOIN ai_turns t ON t.operation_id=tm.operation_id
        JOIN ai_materials m ON m.id=tm.material_id AND m.conversation_id=t.conversation_id
        WHERE t.operation_id=?1 AND m.status='ready' AND m.expires_at>?2 ORDER BY tm.rowid",
    )?;
    let selected = q
        .query_map(params![operation, storage::now()], |r| {
            Ok(Selected {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(selected)
}

fn selected_conversation(con: &Connection, operation: &str, id: &str) -> Result<String, ApiError> {
    con.query_row(
        "SELECT t.conversation_id FROM ai_turns t JOIN ai_turn_materials tm ON tm.operation_id=t.operation_id
         WHERE tm.material_id=?1 AND t.operation_id=?2",
        params![id, operation], |r| r.get(0),
    ).optional()?.ok_or_else(ApiError::not_found)
}

pub(in crate::product) fn leased_list(
    service: &DocumentService,
    op: &Operation,
    id: &str,
    search: Search,
) -> Result<SegmentPage, ApiError> {
    op.actor(service, false)?;
    let db = &service.metadata;
    let conn = db.connection()?;
    let conversation = selected_conversation(&conn, &op.view.id, id)?;
    let (_, segments) = load(db, &conn, &conversation, id)?;
    page(segments, search)
}

pub(in crate::product) fn charge_read(
    con: &Connection,
    op: &Operation,
    bytes: usize,
) -> Result<(), ApiError> {
    let lease = op.lease.as_ref().ok_or_else(ApiError::not_found)?;
    let limit = 256 * 1024;
    let too_large = || {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "source_limit",
            "Read budget for this lease is 256 KiB",
        )
    };
    if bytes > limit {
        return Err(too_large());
    }
    let changed = con.execute(
        "INSERT INTO ai_lease_read_bytes(operation_id,lease_id,bytes) VALUES (?1,?2,?3)
        ON CONFLICT(operation_id,lease_id) DO UPDATE SET bytes=bytes+excluded.bytes WHERE bytes+excluded.bytes<=?4",
        params![op.view.id, lease.id, bytes as i64, limit as i64],
    )?;
    if changed == 0 {
        return Err(too_large());
    }
    Ok(())
}

#[derive(Serialize)]
pub(in crate::product) struct ReadSource {
    source: crate::product::ai::SourceReference,
    text: String,
}

pub(in crate::product) fn leased_read(
    service: &DocumentService,
    op: &mut Operation,
    id: &str,
    sid: &str,
) -> Result<ReadSource, ApiError> {
    op.actor(service, false)?;
    let db = &service.metadata;
    let mut conn = db.connection()?;
    let tx = conn.transaction()?;
    let conversation = selected_conversation(&tx, &op.view.id, id)?;
    let (name, segments) = load(db, &tx, &conversation, id)?;
    let segment = segments
        .into_iter()
        .find(|s| s.location.segment_id == sid)
        .ok_or_else(ApiError::not_found)?;
    charge_read(&tx, op, segment.text.len())?;
    let source = op
        .delivered
        .iter()
        .find(|s| {
            s.material
                .as_ref()
                .is_some_and(|m| m.material_id == id && m.location.segment_id == sid)
        })
        .cloned();
    let source = if let Some(source) = source {
        source
    } else {
        if op.delivered.len() >= 64 {
            return Err(ApiError::invalid("Maximum number of sources reached"));
        }
        let source = crate::product::ai::SourceReference {
            id: Uuid::new_v4().to_string(),
            document_id: String::new(),
            revision: String::new(),
            path: String::new(),
            from: None,
            to: None,
            block_id: None,
            material: Some(Citation {
                kind: MaterialKind::Material,
                conversation_id: conversation,
                material_id: id.to_owned(),
                name,
                location: segment.location,
            }),
        };
        op.delivered.push(source.clone());
        op.store_in(&tx, false)?;
        source
    };
    tx.execute(
        "INSERT OR IGNORE INTO ai_material_reads(operation_id,material_id) VALUES (?1,?2)",
        params![op.view.id, id],
    )?;
    tx.commit()?;
    Ok(ReadSource {
        source,
        text: segment.text,
    })
}
