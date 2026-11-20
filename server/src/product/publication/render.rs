use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
    path::Path,
};

use chrono::{DateTime, NaiveDate};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::Deserialize;
use silverbullet_server_common::revision::sha256_hex;

use crate::revisions::RevisionStore;

use super::{config, git_blobs, Plan, MARKDOWN_LIMIT};
use crate::product::mutations::{max_file_bytes, valid_file_path};

const MAX_OUTPUT: usize = 64 * 1024 * 1024;
const URL_PATH_ENCODING: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'(')
    .add(b')')
    .add(b'[')
    .add(b']');

pub(super) struct Output {
    pub files: BTreeMap<String, Vec<u8>>,
    pub url: Option<String>,
    pub workspace: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FrontMatter {
    title: Option<String>,
    status: Option<String>,
    tags: Vec<String>,
    published_at: Option<String>,
    publication: Vec<Placement>,
}

#[derive(Deserialize)]
struct Placement {
    target: String,
    state: Option<String>,
    slug: Option<String>,
}

struct Page {
    source: String,
    title: String,
    slug: String,
    draft: bool,
    tags: Vec<String>,
    date: Option<String>,
    body: String,
}

pub(super) fn prepare(
    store: &RevisionStore,
    repo: &Path,
    commit: &str,
    plan: &Plan,
) -> Result<Output, String> {
    let target = &plan.target;
    let mut pages = Vec::new();
    let mut slugs = BTreeSet::new();
    let mut source_bytes = 0usize;
    for path in &plan.paths {
        let oid = git_blobs::find(store, repo, commit, path, MARKDOWN_LIMIT)
            .map_err(|_| "Selected document could not be read at the source revision")?
            .ok_or("Selected document is missing at the source revision")?;
        let markdown =
            git_blobs::read(repo, &oid).map_err(|_| "Could not read selected Markdown")?;
        source_bytes += markdown.len();
        if source_bytes > MAX_OUTPUT {
            return Err("Selected Markdown exceeds the publication size limit".into());
        }
        let page = parse_page(path, markdown, &target.id)?;
        if !slugs.insert(page.slug.clone()) {
            return Err(format!("Duplicate publication slug: {}", page.slug));
        }
        pages.push(page);
    }
    let mut output = Output {
        files: BTreeMap::new(),
        url: pages
            .iter()
            .find(|page| !page.draft)
            .map(|page| target.public_url(&page.slug)),
        workspace: plan.request.workspace_id.clone(),
    };
    let mut total_bytes = 0usize;
    let section = format!("+++\ntitle = {}\n+++\n", toml_string(&target.label)?);
    add_file(
        &mut output.files,
        &mut total_bytes,
        target.section_file(),
        section.into_bytes(),
    )?;

    let by_source = pages
        .iter()
        .map(|page| (page.source.as_str(), page))
        .collect::<BTreeMap<_, _>>();
    for page in &pages {
        let directory = format!("{}/{}", target.content_path, page.slug);
        let mut assets = BTreeMap::<String, String>::new();
        let body = rewrite_links(&page.body, |link, wiki| {
            if link.starts_with('#') || link.is_empty() {
                return Ok(None);
            }
            if let Some((scheme, _)) = link.split_once(':') {
                if matches!(
                    scheme.to_ascii_lowercase().as_str(),
                    "https" | "http" | "mailto" | "tel"
                ) {
                    return Ok(None);
                }
                return Err("Unsupported URL scheme in publication link".into());
            }
            let boundary = link.find(['?', '#']).unwrap_or(link.len());
            let location = percent_decode_str(&link[..boundary])
                .decode_utf8()
                .map_err(|_| "Invalid UTF-8 publication link")?;
            let mut path = resolve_relative(&page.source, &location)?;
            if wiki && !path.ends_with(".md") {
                path.push_str(".md");
            }
            let suffix = &link[boundary..];
            if path.to_ascii_lowercase().ends_with(".md") {
                if suffix.starts_with('?') {
                    return Err("Internal Markdown links cannot include a query string".into());
                }
                let destination = by_source.get(path.as_str()).ok_or_else(|| {
                    format!("Linked document must be selected for publication: {path}")
                })?;
                if !page.draft && destination.draft {
                    return Err(format!("A published document links to a draft: {path}"));
                }
                return Ok(Some(format!(
                    "@/{}/{}/index.md{suffix}",
                    target.section_path(),
                    destination.slug
                )));
            }
            let relative = match assets.get(&path) {
                Some(relative) => relative.clone(),
                None => {
                    let directory_prefix = page
                        .source
                        .rsplit_once('/')
                        .map_or("".to_owned(), |(parent, _)| format!("{parent}/"));
                    let relative = if let Some(local) = path.strip_prefix(&directory_prefix) {
                        format!("assets/{local}")
                    } else {
                        format!("assets-from-workspace/{path}")
                    };
                    let oid = git_blobs::find(store, repo, commit, &path, max_file_bytes(&path))
                        .map_err(|_| format!("Invalid publication asset: {path}"))?
                        .ok_or_else(|| format!("Missing publication asset: {path}"))?;
                    let bytes = git_blobs::read(repo, &oid)
                        .map_err(|_| format!("Could not read publication asset: {path}"))?;
                    add_file(
                        &mut output.files,
                        &mut total_bytes,
                        format!("{directory}/{relative}"),
                        bytes,
                    )?;
                    assets.insert(path, relative.clone());
                    relative
                }
            };
            Ok(Some(format!(
                "{}{suffix}",
                utf8_percent_encode(&relative, URL_PATH_ENCODING)
            )))
        })?;
        let front = page_front_matter(page, &target.template)?;
        add_file(
            &mut output.files,
            &mut total_bytes,
            format!("{directory}/index.md"),
            format!("{front}{body}").into_bytes(),
        )?;
    }
    Ok(output)
}

fn parse_page(path: &str, bytes: Vec<u8>, target: &str) -> Result<Page, String> {
    let text = String::from_utf8(bytes).map_err(|_| format!("Markdown is not UTF-8: {path}"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let (front, body) = split_front_matter(text)?;
    let matching = front
        .publication
        .iter()
        .filter(|placement| placement.target == target)
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(format!("Duplicate publication settings for {path}"));
    }
    let placement = matching.first();
    let name = path
        .rsplit('/')
        .next()
        .and_then(|file| file.strip_suffix(".md"))
        .unwrap_or(path);
    let title = front.title.unwrap_or_else(|| name.to_owned());
    let slug = match placement.and_then(|record| record.slug.as_ref()) {
        Some(slug) if config::slug(slug) => slug.clone(),
        Some(_) => return Err(format!("Invalid publication slug for {path}")),
        None => fallback_slug(name, path),
    };
    let draft = front
        .status
        .as_deref()
        .is_some_and(|status| status != "published")
        || placement
            .and_then(|item| item.state.as_deref())
            .is_some_and(|state| state != "published");
    let date = front
        .published_at
        .map(|date| {
            if NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_ok()
                || DateTime::parse_from_rfc3339(&date).is_ok()
            {
                Ok(date)
            } else {
                Err(format!("Invalid published_at date for {path}"))
            }
        })
        .transpose()?;
    let mut tags = front.tags;
    tags.sort();
    tags.dedup();
    Ok(Page {
        source: path.to_owned(),
        title,
        slug,
        draft,
        tags,
        date,
        body: body.to_owned(),
    })
}

fn split_front_matter(text: &str) -> Result<(FrontMatter, &str), String> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or_default();
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return Ok((FrontMatter::default(), text));
    }
    let mut offset = first.len();
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let front = serde_yaml::from_str::<Option<FrontMatter>>(&text[first.len()..offset])
                .map_err(|_| "Invalid YAML publication front matter")?
                .unwrap_or_default();
            return Ok((front, &text[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err("Unterminated YAML publication front matter".into())
}

fn fallback_slug(name: &str, path: &str) -> String {
    let folded = name.to_ascii_lowercase();
    let slug = folded
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if config::slug(&slug) {
        slug
    } else {
        format!("document-{}", &sha256_hex(path.as_bytes())[..12])
    }
}

fn page_front_matter(page: &Page, template: &str) -> Result<String, String> {
    let mut front = format!(
        "+++\ntitle = {}\nslug = {}\ndraft = {}\ntemplate = {}\n",
        toml_string(&page.title)?,
        toml_string(&page.slug)?,
        page.draft,
        toml_string(template)?
    );
    if let Some(date) = &page.date {
        front.push_str(&format!("date = {date}\n"));
    }
    if !page.tags.is_empty() {
        let tags = page
            .tags
            .iter()
            .map(|tag| toml_string(tag))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        front.push_str(&format!("[taxonomies]\ntags = [{tags}]\n"));
    }
    front.push_str("+++\n");
    Ok(front)
}

fn toml_string(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Publication metadata cannot contain control characters".into());
    }
    serde_json::to_string(value).map_err(|_| "Invalid publication metadata".into())
}

fn resolve_relative(source: &str, location: &str) -> Result<String, String> {
    if location.starts_with('/') || location.contains(['\\', ':']) {
        return Err("Publication resource links must use safe relative paths".into());
    }
    let parent = source.rsplit_once('/').map_or("", |(parent, _)| parent);
    let mut segments = parent
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    for part in location.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                segments
                    .pop()
                    .ok_or("Publication resource link leaves the workspace")?;
            }
            part => segments.push(part),
        }
    }
    let path = segments.join("/");
    if !valid_file_path(&path) {
        return Err("Unsafe publication resource location".into());
    }
    Ok(path)
}

fn add_file(
    files: &mut BTreeMap<String, Vec<u8>>,
    bytes: &mut usize,
    path: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    *bytes += contents.len();
    if *bytes > MAX_OUTPUT {
        return Err("Publication exceeds its generated file size limit".into());
    }
    if files.insert(path.clone(), contents).is_some() {
        return Err(format!(
            "Publication generates a duplicate output path: {path}"
        ));
    }
    Ok(())
}

fn rewrite_links(
    body: &str,
    mut resolve: impl FnMut(&str, bool) -> Result<Option<String>, String>,
) -> Result<String, String> {
    let parser = Parser::new_ext(
        body,
        Options::ENABLE_WIKILINKS
            | Options::ENABLE_TABLES
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS,
    );
    let mut parsed = parser.into_offset_iter();
    let mut changes = BTreeMap::<usize, (Range<usize>, String)>::new();
    while let Some((event, span)) = parsed.next() {
        let (kind, destination, id) = match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                id,
                ..
            })
            | Event::Start(Tag::Image {
                link_type,
                dest_url,
                id,
                ..
            }) => (link_type, dest_url, id),
            Event::Html(html) | Event::InlineHtml(html) if html_links(&html) => {
                return Err("Use Markdown syntax for publication links and images".into())
            }
            _ => continue,
        };
        let wiki = matches!(kind, LinkType::WikiLink { .. });
        let Some(replacement) = resolve(&destination, wiki)? else {
            continue;
        };
        let (range, value) = match kind {
            LinkType::Inline => {
                let raw = &body[span.clone()];
                let marker = raw
                    .rfind("](")
                    .ok_or("Could not locate a Markdown link destination")?
                    + 2;
                (
                    destination_span(body, span.start + marker, span.end)?,
                    replacement,
                )
            }
            LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
                let definition = parsed
                    .reference_definitions()
                    .get(&id)
                    .ok_or("Could not locate a Markdown reference definition")?;
                let raw = &body[definition.span.clone()];
                let colon = raw
                    .find("]:")
                    .ok_or("Could not locate a Markdown reference destination")?
                    + 2;
                (
                    destination_span(body, definition.span.start + colon, definition.span.end)?,
                    replacement,
                )
            }
            LinkType::WikiLink { .. } => {
                let raw = body[span.clone()]
                    .trim_start_matches('[')
                    .trim_end_matches(']');
                let label = raw
                    .split_once('|')
                    .map_or(raw, |(_, label)| label)
                    .replace(['[', ']'], "");
                (span, format!("[{label}]({replacement})"))
            }
            _ => return Err("Unsupported relative publication link syntax".into()),
        };
        changes.insert(range.start, (range, value));
    }
    let mut rendered = body.to_owned();
    let mut boundary = body.len();
    for (_, (range, replacement)) in changes.into_iter().rev() {
        if range.end > boundary {
            return Err("Publication links overlap".into());
        }
        boundary = range.start;
        rendered.replace_range(range, &replacement);
    }
    Ok(rendered)
}

fn destination_span(body: &str, after_marker: usize, end: usize) -> Result<Range<usize>, String> {
    let remaining = &body[after_marker..end];
    let trimmed = remaining.trim_start();
    let start = end - trimmed.len();
    if let Some(angular) = trimmed.strip_prefix('<') {
        let close = angular
            .find('>')
            .ok_or("Unterminated Markdown link destination")?;
        return Ok((start + 1)..(start + 1 + close));
    }
    let mut depth = 0;
    let mut escaped = false;
    for (offset, character) in trimmed.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '(' => depth += 1,
            ')' if depth == 0 => return Ok(start..(start + offset)),
            ')' => depth -= 1,
            character if character.is_whitespace() && depth == 0 => {
                return Ok(start..(start + offset))
            }
            _ => {}
        }
    }
    Ok(start..end)
}

fn html_links(raw: &str) -> bool {
    let lowercase = raw.to_ascii_lowercase();
    lowercase.contains("href") || lowercase.contains("src")
}
