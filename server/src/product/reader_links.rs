use super::db::Metadata;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{fs, io};

pub(super) struct ReaderLinks(Option<String>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReaderLink {
    pub reader_path: String,
    pub reader_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_url_error: Option<&'static str>,
}

impl ReaderLinks {
    pub(super) fn load(metadata: &Metadata) -> Result<Self, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Config {
            public_reader_url: Option<String>,
        }
        let bytes = match fs::read(metadata.product_file("server.json")) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Self(None)),
            Err(_) => return Err("Could not read Librarian server.json".into()),
        };
        let config: Config = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid server.json publicReaderUrl configuration")?;
        let Some(raw) = config.public_reader_url else {
            return Ok(Self(None));
        };
        let invalid="publicReaderUrl must be an absolute HTTPS base URL without credentials, query or fragment";
        let url = Url::parse(&raw).map_err(|_| invalid)?;
        let loopback =
            cfg!(debug_assertions) && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port() == Some(0)
            || raw.contains('\\')
            || raw.chars().any(char::is_whitespace)
            || raw.split_once("://").is_none_or(|(_, s)| {
                s.split('/')
                    .next()
                    .is_none_or(|a| a.is_empty() || a.contains('@'))
            })
        {
            return Err(invalid.into());
        }
        Ok(Self(Some(url.as_str().trim_end_matches('/').to_owned())))
    }
    pub(super) fn link(&self, reader_path: String) -> ReaderLink {
        ReaderLink {
            reader_url: self.0.as_ref().map(|base| format!("{base}{reader_path}")),
            reader_url_error: self.0.is_none().then_some("reader_url_unavailable"),
            reader_path,
        }
    }
    pub(super) fn document(&self, workspace: &str, document: &str) -> ReaderLink {
        self.link(format!("/workspaces/{workspace}/documents/{document}"))
    }
}
