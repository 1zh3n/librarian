use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::Serialize;

use crate::{
    link_resolve::{normalize_path, resolve_path, split_ref, BasenameIndex},
    state::ServerState,
};

use super::{
    auth::Account,
    contract::{ApiError, DocumentSummary},
    documents::{
        is_document_path, product_read, read_markdown, run, state, DocumentService, MARKDOWN_LIMIT,
    },
};

const MAX_SCAN_FILES: usize = 512;
const MAX_SCAN_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESULTS: usize = 100;

#[derive(Serialize)]
pub(super) struct DocumentReferences {
    outgoing: Vec<DocumentSummary>,
    backlinks: Vec<DocumentSummary>,
    partial: bool,
}

pub(super) async fn get_references(
    State(service): State<Arc<DocumentService>>,
    Path(document): Path<String>,
    headers: HeaderMap,
) -> Result<Json<DocumentReferences>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    run(move || lookup(&service, &account, &document))
        .await
        .map(Json)
}

fn lookup(
    service: &DocumentService,
    account: &Account,
    document: &str,
) -> Result<DocumentReferences, ApiError> {
    let (instance, _, workspace, _) = service.document_scope(account, document, false)?;
    let state = state(&instance)?;
    let _mutation = product_read(state)?;
    let source = service.path_in(&workspace, document)?;
    let markdown = read_markdown(state, &source)?;
    let files: BTreeMap<_, _> = state
        .space
        .fetch_file_list()?
        .into_iter()
        .filter(|file| is_document_path(&file.name))
        .filter_map(|file| {
            let size = usize::try_from(file.size).ok()?;
            (size <= MARKDOWN_LIMIT).then_some((file.name, size))
        })
        .collect();
    let index = BasenameIndex::from_paths(files.keys().cloned());
    let mut budget = ScanBudget {
        remaining_bytes: MAX_SCAN_BYTES - markdown.len(),
        remaining_files: MAX_SCAN_FILES,
        partial: false,
    };

    let mut outgoing = Vec::new();
    let targets: BTreeSet<_> = linked_documents(&markdown, &source, &index).collect();
    for path in targets {
        if outgoing.len() == MAX_RESULTS || budget.remaining_files == 0 {
            budget.partial = true;
            break;
        }
        if let Some(size) = files.get(&path) {
            if let Some(markdown) = budget.read(state, &path, *size)? {
                outgoing.push(service.summary_from_markdown(state, &workspace, path, &markdown)?);
            }
        }
    }

    let mut backlinks = Vec::new();
    for (path, size) in files.into_iter().filter(|(path, _)| *path != source) {
        if backlinks.len() == MAX_RESULTS || budget.remaining_files == 0 {
            budget.partial = true;
            break;
        }
        let Some(markdown) = budget.read(state, &path, size)? else {
            continue;
        };
        if linked_documents(&markdown, &path, &index).any(|target| target == source) {
            backlinks.push(service.summary_from_markdown(state, &workspace, path, &markdown)?);
        }
    }
    Ok(DocumentReferences {
        outgoing,
        backlinks,
        partial: budget.partial,
    })
}

struct ScanBudget {
    remaining_bytes: usize,
    remaining_files: usize,
    partial: bool,
}

impl ScanBudget {
    fn read(
        &mut self,
        state: &ServerState,
        path: &str,
        listed_size: usize,
    ) -> Result<Option<String>, ApiError> {
        if listed_size > self.remaining_bytes {
            self.partial = true;
            return Ok(None);
        }
        let remaining_before_read = self.remaining_bytes;
        self.remaining_bytes -= listed_size;
        self.remaining_files -= 1;
        let markdown = match read_markdown(state, path) {
            Ok(markdown) => markdown,
            Err(error) if error.is_file_conflict() => return Ok(None),
            Err(error) => return Err(error),
        };
        // A native edit may change the file size before the listing cache catches up.
        match remaining_before_read.checked_sub(markdown.len()) {
            Some(remaining) => {
                self.remaining_bytes = remaining;
                Ok(Some(markdown))
            }
            None => {
                self.remaining_bytes = 0;
                self.partial = true;
                Ok(None)
            }
        }
    }
}

pub(super) fn linked_documents<'a>(
    markdown: &'a str,
    source: &'a str,
    index: &'a BasenameIndex,
) -> impl Iterator<Item = String> + 'a {
    let markdown = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let options = Options::ENABLE_WIKILINKS
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    Parser::new_ext(markdown, options).filter_map(move |event| {
        let Event::Start(Tag::Link {
            link_type,
            dest_url,
            ..
        }) = event
        else {
            return None;
        };
        let path = if matches!(link_type, LinkType::WikiLink { .. }) {
            let (path, _) = split_ref(&dest_url)?;
            resolve_path(&normalize_path(path), source, index).path
        } else {
            relative_document(source, &dest_url)?
        };
        (path != source && index.has(&path)).then_some(path)
    })
}

fn relative_document(source: &str, href: &str) -> Option<String> {
    let location = href.split(['?', '#']).next()?;
    if location.is_empty() || location.starts_with("//") || location.contains(['\\', ':']) {
        return None;
    }
    let (parent, relative) = match location.strip_prefix('/') {
        Some(root_relative) => ("", root_relative),
        None => (
            source.rsplit_once('/').map_or("", |(parent, _)| parent),
            location,
        ),
    };
    let mut segments: Vec<_> = parent
        .split('/')
        .filter(|part| !part.is_empty())
        .map(Cow::Borrowed)
        .collect();
    let mut relative = relative.split('/').peekable();
    while let Some(segment) = relative.next() {
        // Resolve dot segments before any escaped slash can become a path separator.
        let segment = percent_decode_str(segment).decode_utf8().ok()?;
        match segment.as_ref() {
            "." | ".." if relative.peek().is_none() => return None,
            "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    let path = segments.join("/");
    is_document_path(&path).then_some(path)
}
