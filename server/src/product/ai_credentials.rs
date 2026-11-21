use std::{
    fs,
    io::{self, Write},
    path::Path,
};

use axum::http::StatusCode;
use silverbullet_server_common::crypto::{decrypt_bound, encrypt_bound, KEY_LEN};

use super::contract::ApiError;

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "ai_credential_unavailable",
        "Re-enter the connection credential",
    )
}

fn read_key(path: &Path) -> io::Result<[u8; KEY_LEN]> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() != KEY_LEN as u64 {
        return Err(io::Error::other("Invalid installation key"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::other(
                "Installation key permissions are too broad",
            ));
        }
    }
    fs::read(path)?
        .try_into()
        .map_err(|_| io::Error::other("Invalid installation key length"))
}

fn installation_key(path: &Path) -> Result<[u8; KEY_LEN], ApiError> {
    match read_key(path) {
        Ok(key) => return Ok(key),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err(unavailable()),
    }
    let directory = path.parent().ok_or_else(unavailable)?;
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(ApiError::internal)?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(ApiError::internal)?;
    file.write_all(&key).map_err(ApiError::internal)?;
    file.as_file().sync_all().map_err(ApiError::internal)?;
    match file.persist_noclobber(path) {
        Ok(_) => {
            #[cfg(unix)]
            fs::File::open(directory)
                .and_then(|dir| dir.sync_all())
                .map_err(ApiError::internal)?;
            Ok(key)
        }
        Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {
            read_key(path).map_err(|_| unavailable())
        }
        Err(err) => Err(ApiError::internal(err.error)),
    }
}

pub(super) fn seal(path: &Path, connection: &str, secret: &str) -> Result<String, ApiError> {
    encrypt_bound(&installation_key(path)?, secret, connection.as_bytes())
        .map_err(|_| unavailable())
}

pub(super) fn unseal(path: &Path, connection: &str, ciphertext: &str) -> Result<String, ApiError> {
    let key = read_key(path).map_err(|_| unavailable())?;
    decrypt_bound(&key, ciphertext, connection.as_bytes()).map_err(|_| unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_bound_to_the_connection_and_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ai-install.key");
        let first = seal(&path, "a", "temporary-test-key").unwrap();
        let second = seal(&path, "a", "temporary-test-key").unwrap();
        assert_ne!(first, second);
        assert!(!first.contains("temporary-test-key"));
        assert_eq!(unseal(&path, "a", &first).unwrap(), "temporary-test-key");
        assert!(unseal(&path, "b", &first).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(unseal(&path, "a", &first).is_err());
        assert!(!path.exists());
        let replaced = seal(&path, "a", "fresh").unwrap();
        assert!(unseal(&path, "a", &first).is_err());
        assert_eq!(unseal(&path, "a", &replaced).unwrap(), "fresh");
    }
}
