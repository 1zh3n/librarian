use std::{collections::BTreeSet, fs, path::PathBuf};

use axum::http::Uri;
use serde::{Deserialize, Serialize};

use crate::product::mutations::valid_file_path;

use super::{ApiError, Metadata};

const CONFIG_LIMIT: u64 = 128 * 1024;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Target {
    pub id: String,
    pub label: String,
    pub workspace_id: String,
    pub repository: PathBuf,
    pub branch: String,
    pub content_path: String,
    pub template: String,
    pub base_url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetConfig {
    targets: Vec<Target>,
}

#[derive(Serialize)]
pub(super) struct TargetSummary {
    pub id: String,
    pub label: String,
}

impl Target {
    pub fn reference(&self) -> String {
        format!("refs/heads/{}", self.branch)
    }

    pub fn section_path(&self) -> &str {
        self.content_path
            .strip_prefix("content/")
            .unwrap_or_default()
    }

    pub fn public_url(&self, slug: &str) -> String {
        format!(
            "{}/{}/{slug}/",
            self.base_url.trim_end_matches('/'),
            self.section_path()
        )
    }

    pub fn section_file(&self) -> String {
        format!("{}/_index.md", self.content_path)
    }

    pub fn manifest_file(&self) -> String {
        format!(".librarian-zola/{}.json", self.id)
    }

    pub fn new_file_allowed(&self, file: &str) -> bool {
        valid_file_path(file)
            && file
                .strip_prefix(&self.content_path)
                .is_some_and(|rest| rest.starts_with('/'))
    }

    fn valid(&self) -> bool {
        let parsed_base = self.base_url.parse::<Uri>();
        slug(&self.id)
            && !self.label.trim().is_empty()
            && self.label.len() <= 160
            && self.branch.split('/').all(|component| {
                !component.is_empty()
                    && component
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
            && !self.section_path().is_empty()
            && self.section_path().split('/').all(slug)
            && valid_file_path(&self.template)
            && self.template.ends_with(".html")
            && self.repository.is_absolute()
            && parsed_base.is_ok_and(|base| {
                matches!(base.scheme_str(), Some("http" | "https"))
                    && base
                        .authority()
                        .is_some_and(|authority| !authority.as_str().contains('@'))
                    && base.query().is_none()
            })
    }
}

pub(super) fn slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn list(metadata: &Metadata, workspace: &str) -> Result<Vec<TargetSummary>, ApiError> {
    Ok(configured(metadata)?
        .into_iter()
        .filter(|target| target.workspace_id == workspace)
        .map(|target| TargetSummary {
            id: target.id,
            label: target.label,
        })
        .collect())
}

pub(super) fn get(
    metadata: &Metadata,
    workspace: &str,
    requested: &str,
) -> Result<Target, ApiError> {
    let mut target = configured(metadata)?
        .into_iter()
        .find(|target| target.workspace_id == workspace && target.id == requested)
        .ok_or_else(ApiError::not_found)?;
    let config_path = metadata.product_file("publication-targets.json");
    let data_root = config_path
        .parent()
        .and_then(|directory| directory.parent())
        .ok_or_else(|| ApiError::internal("Missing product data directory"))?
        .canonicalize()
        .map_err(ApiError::internal)?;
    target.repository = target
        .repository
        .canonicalize()
        .map_err(ApiError::internal)?;
    if !target.repository.is_dir()
        || target.repository.starts_with(&data_root)
        || data_root.starts_with(&target.repository)
    {
        return Err(ApiError::invalid(
            "Publication target must be a separate local bare Git repository",
        ));
    }
    Ok(target)
}

fn configured(metadata: &Metadata) -> Result<Vec<Target>, ApiError> {
    let path = metadata.product_file("publication-targets.json");
    let details = match fs::symlink_metadata(&path) {
        Ok(details) => details,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ApiError::internal(error)),
    };
    if !details.is_file() || details.len() > CONFIG_LIMIT {
        return Err(ApiError::internal(
            "Invalid publication targets configuration file",
        ));
    }
    let text = fs::read(path).map_err(ApiError::internal)?;
    let config: TargetConfig = serde_json::from_slice(&text).map_err(ApiError::internal)?;
    let mut ids = BTreeSet::new();
    for target in &config.targets {
        if !target.valid() || !ids.insert((&target.workspace_id, &target.id)) {
            return Err(ApiError::internal(
                "Invalid or duplicate publication target",
            ));
        }
    }
    Ok(config.targets)
}
