use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, OptionalExtension, Transaction};
use silverbullet_server_common::revision::sha256_hex;

use super::{contract::ApiError, db::Metadata};
use crate::multi::config::MemberRole;

pub(super) const DEFAULT_EXPIRY_SECS: i64 = 7 * 24 * 3600;
pub(super) const MAX_EXPIRY_SECS: i64 = 30 * 24 * 3600;

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS account_invites (
           id TEXT PRIMARY KEY,
           token_hash TEXT NOT NULL UNIQUE,
           username TEXT NOT NULL,
           admin INTEGER NOT NULL DEFAULT 0,
           role TEXT NOT NULL CHECK (role IN ('read', 'write')),
           workspaces TEXT NOT NULL,
           created_by TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL,
           accepted_at INTEGER,
           revoked INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS account_invites_token ON account_invites(token_hash);
         CREATE INDEX IF NOT EXISTS account_invites_username ON account_invites(username);",
    )
}

#[derive(Clone)]
pub(super) struct NewInvite {
    pub username: String,
    pub admin: bool,
    pub role: MemberRole,
    pub workspace_ids: Vec<String>,
    pub created_by: String,
    pub expires_at: i64,
}

#[derive(Clone)]
pub(super) struct Invite {
    pub id: String,
    pub username: String,
    pub admin: bool,
    pub role: MemberRole,
    pub workspace_ids: Vec<String>,
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub accepted_at: Option<i64>,
    pub revoked: bool,
}

fn role_str(role: MemberRole) -> &'static str {
    match role {
        MemberRole::Read => "read",
        MemberRole::Write => "write",
    }
}

fn parse_role(value: &str) -> Result<MemberRole, ApiError> {
    match value {
        "read" => Ok(MemberRole::Read),
        "write" => Ok(MemberRole::Write),
        _ => Err(ApiError::internal("Invalid invite role")),
    }
}

fn row_to_invite(row: &rusqlite::Row<'_>) -> rusqlite::Result<Invite> {
    let workspaces: String = row.get(4)?;
    let workspace_ids: Vec<String> = serde_json::from_str(&workspaces).unwrap_or_default();
    Ok(Invite {
        id: row.get(0)?,
        username: row.get(1)?,
        admin: row.get::<_, i64>(2)? != 0,
        role: parse_role(&row.get::<_, String>(3)?).map_err(|_| rusqlite::Error::InvalidQuery)?,
        workspace_ids,
        created_by: row.get(5)?,
        created_at: row.get(6)?,
        expires_at: row.get(7)?,
        accepted_at: row.get(8)?,
        revoked: row.get::<_, i64>(9)? != 0,
    })
}

pub(super) fn create(metadata: &Metadata, input: NewInvite) -> Result<(String, Invite), ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = sha256_hex(token.as_bytes());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let now = chrono::Utc::now().timestamp();
    let expires_at = if input.expires_at == 0 {
        now + DEFAULT_EXPIRY_SECS
    } else {
        input.expires_at.clamp(now + 60, now + MAX_EXPIRY_SECS)
    };
    metadata.connection()?.execute(
        "INSERT INTO account_invites
           (id, token_hash, username, admin, role, workspaces, created_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            hash,
            input.username,
            input.admin as i64,
            role_str(input.role),
            serde_json::to_string(&input.workspace_ids).map_err(ApiError::internal)?,
            input.created_by,
            now,
            expires_at,
        ],
    )?;
    let invite = find_by_id(metadata, &id)?;
    Ok((token, invite))
}

pub(super) fn find_by_token(
    metadata: &Metadata,
    token: &str,
    now: i64,
) -> Result<Invite, ApiError> {
    let hash = sha256_hex(token.as_bytes());
    let invite = metadata
        .connection()?
        .query_row(
            "SELECT id, username, admin, role, workspaces, created_by, created_at, expires_at,
                    accepted_at, revoked
             FROM account_invites WHERE token_hash = ?1",
            [hash],
            row_to_invite,
        )
        .optional()?
        .ok_or_else(ApiError::not_found)?;
    if invite.revoked || invite.accepted_at.is_some() || invite.expires_at <= now {
        return Err(ApiError::not_found());
    }
    Ok(invite)
}

pub(super) fn find_by_id(metadata: &Metadata, id: &str) -> Result<Invite, ApiError> {
    metadata
        .connection()?
        .query_row(
            "SELECT id, username, admin, role, workspaces, created_by, created_at, expires_at,
                    accepted_at, revoked
             FROM account_invites WHERE id = ?1",
            [id],
            row_to_invite,
        )
        .optional()?
        .ok_or_else(ApiError::not_found)
}

pub(super) fn list(metadata: &Metadata) -> Result<Vec<Invite>, ApiError> {
    let connection = metadata.connection()?;
    let mut statement = connection.prepare(
        "SELECT id, username, admin, role, workspaces, created_by, created_at, expires_at,
                accepted_at, revoked
         FROM account_invites ORDER BY created_at DESC LIMIT 100",
    )?;
    let rows = statement.query_map([], row_to_invite)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(ApiError::from)
}

pub(super) fn accept(metadata: &Metadata, id: &str, now: i64) -> Result<(), ApiError> {
    let changed = metadata.connection()?.execute(
        "UPDATE account_invites SET accepted_at = ?2
         WHERE id = ?1 AND accepted_at IS NULL AND revoked = 0 AND expires_at > ?2",
        params![id, now],
    )?;
    if changed == 1 {
        Ok(())
    } else {
        Err(ApiError::not_found())
    }
}

pub(super) fn revoke(metadata: &Metadata, id: &str) -> Result<(), ApiError> {
    let changed = metadata
        .connection()?
        .execute("UPDATE account_invites SET revoked = 1 WHERE id = ?1", [id])?;
    if changed == 1 {
        Ok(())
    } else {
        Err(ApiError::not_found())
    }
}

#[cfg(test)]
mod tests {
    use super::{create, find_by_token, migrate, NewInvite};
    use crate::multi::config::MemberRole;
    use crate::product::db::Metadata;
    use tempfile::tempdir;

    #[test]
    fn invite_tokens_are_one_time_and_expire() {
        let dir = tempdir().unwrap();
        let metadata = Metadata::open(dir.path()).unwrap();
        let connection = metadata.connection().unwrap();
        let transaction = connection.unchecked_transaction().unwrap();
        migrate(&transaction).unwrap();
        transaction.commit().unwrap();
        drop(connection);
        let (token, invite) = create(
            &metadata,
            NewInvite {
                username: "new-reader".into(),
                admin: false,
                role: MemberRole::Write,
                workspace_ids: vec!["ws_1".into()],
                created_by: "admin".into(),
                expires_at: 0,
            },
        )
        .unwrap();
        assert_eq!(invite.username, "new-reader");
        assert!(find_by_token(&metadata, &token, invite.expires_at - 1).is_ok());
        assert!(find_by_token(&metadata, &token, invite.expires_at).is_err());
    }
}
