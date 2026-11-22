//! Zero-JavaScript reading pages for e-ink, printing, shared snapshots and
//! low-power browsers. The SPA remains the editing/interactive surface.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use minijinja::{context, AutoEscape, Environment, Value};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Deserialize;

use super::{
    auth::Account,
    contract::ApiError,
    delivery,
    documents::{self, state, DocumentService},
    image_policy, mutations,
    snapshots::SnapshotView,
};

const TEMPLATE: &str = include_str!("static_reading.html");
const CSP: &str = "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PATH_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'\\');

pub(super) fn routes(service: Arc<DocumentService>) -> Router {
    Router::new()
        .route("/r/{snapshot}/read", get(snapshot_reading))
        .route(
            "/workspaces/{workspace}/documents/{document}/read",
            get(document_reading),
        )
        .with_state(service)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadingQuery {
    document_id: Option<String>,
    eink: Option<String>,
    theme: Option<String>,
}

impl ReadingQuery {
    fn eink(&self) -> bool {
        self.eink
            .as_deref()
            .is_some_and(|value| !matches!(value, "0" | "false" | "no"))
    }

    fn theme(&self) -> &'static str {
        match self.theme.as_deref() {
            Some("light") => "light",
            Some("dark") => "dark",
            _ => "auto",
        }
    }
}

pub(super) struct NavItem {
    title: String,
    url: String,
    current: bool,
}

pub(super) struct StaticLinks {
    documents: BTreeMap<String, String>,
    assets: BTreeSet<String>,
    asset_base: String,
    query: String,
}

impl StaticLinks {
    fn append_query(&self, url: &str) -> String {
        if self.query.is_empty() {
            url.to_owned()
        } else if url.contains('?') {
            format!("{url}&{}", self.query.trim_start_matches('?'))
        } else {
            format!("{url}{}", self.query)
        }
    }

    fn document(&self, path: &str) -> Option<String> {
        self.documents.get(path).map(|url| self.append_query(url))
    }

    fn asset(&self, path: &str) -> Option<String> {
        self.assets
            .contains(path)
            .then(|| format!("{}{}", self.asset_base, encode_path(path)))
    }

    fn image(&self, path: &str) -> Option<String> {
        (image_policy::is_image_extension(path))
            .then(|| self.asset(path))
            .flatten()
    }

    fn resolve(&self, href: &str, current_path: &str, image: bool) -> Option<String> {
        if href.is_empty() {
            return None;
        }
        if href.starts_with('#') {
            return Some(href.to_owned());
        }
        if href.starts_with("http://")
            || href.starts_with("https://")
            || href.starts_with("mailto:")
        {
            return Some(href.to_owned());
        }
        if href.starts_with("//") || href.starts_with("data:") || href.starts_with("javascript:") {
            return None;
        }
        let (path, fragment) = split_reference(href)?;
        let resolved = resolve_relative(current_path, &path)?;
        if resolved.starts_with('.') {
            return None;
        }
        let mut target = if image {
            self.image(&resolved)?
        } else {
            self.document(&resolved).or_else(|| self.asset(&resolved))?
        };
        if !image && !fragment.is_empty() {
            target.push('#');
            target.push_str(&fragment);
        }
        Some(target)
    }
}

pub(super) struct StaticPage {
    pub title: String,
    pub markdown: String,
    pub path: String,
    pub reader_url: String,
    pub kind: Option<&'static str>,
    pub nav: Vec<NavItem>,
    pub links: StaticLinks,
    pub eink: bool,
    pub theme: &'static str,
}

pub(super) fn snapshot_static_page(
    view: &SnapshotView,
    eink: bool,
    theme: &'static str,
) -> StaticPage {
    let query = query_suffix(eink, theme);
    let documents = view
        .documents
        .iter()
        .map(|document| {
            (
                document.path.clone(),
                format!(
                    "/r/{}/read?documentId={}",
                    encode_component(&view.id),
                    encode_component(&document.id)
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let nav = view
        .documents
        .iter()
        .map(|document| NavItem {
            title: document.title.clone(),
            url: append_query(
                &format!(
                    "/r/{}/read?documentId={}",
                    encode_component(&view.id),
                    encode_component(&document.id)
                ),
                &query,
            ),
            current: document.id == view.document.summary.id,
        })
        .collect();
    StaticPage {
        title: view.document.summary.title.clone(),
        markdown: view.document.markdown.clone(),
        path: view.document.summary.path.clone(),
        reader_url: format!("/r/{}", encode_component(&view.id)),
        kind: Some(view.kind_label()),
        nav,
        links: StaticLinks {
            documents,
            assets: view.attachment_paths.iter().cloned().collect(),
            asset_base: format!("/api/v1/snapshots/{}/assets/", encode_component(&view.id)),
            query,
        },
        eink,
        theme,
    }
}

pub(super) struct DocumentPageInput {
    pub(super) workspace: String,
    pub(super) document: String,
    pub(super) title: String,
    pub(super) markdown: String,
    pub(super) path: String,
    pub(super) documents: BTreeMap<String, String>,
    pub(super) assets: BTreeSet<String>,
    pub(super) eink: bool,
    pub(super) theme: &'static str,
}

pub(super) fn document_static_page(input: DocumentPageInput) -> StaticPage {
    StaticPage {
        title: input.title,
        markdown: input.markdown,
        path: input.path,
        reader_url: format!(
            "/workspaces/{}/documents/{}",
            encode_component(&input.workspace),
            encode_component(&input.document)
        ),
        kind: None,
        nav: Vec::new(),
        links: StaticLinks {
            documents: input.documents,
            assets: input.assets,
            asset_base: format!(
                "/api/v1/workspaces/{}/assets/",
                encode_component(&input.workspace)
            ),
            query: query_suffix(input.eink, input.theme),
        },
        eink: input.eink,
        theme: input.theme,
    }
}

pub(super) fn render(page: StaticPage) -> Result<String, ApiError> {
    let body = render_markdown(&page.markdown, &page.path, &page.links);
    let show_title = !first_h1_matches(&page.markdown, &page.title);
    let nav = page
        .nav
        .into_iter()
        .map(|item| {
            context! {
                title => item.title,
                url => item.url,
                current => item.current,
            }
        })
        .collect::<Vec<Value>>();
    let mut env = Environment::new();
    env.set_auto_escape_callback(|_| AutoEscape::Html);
    env.render_str(
        TEMPLATE,
        context! {
            title => page.title,
            kind => page.kind,
            show_title => show_title,
            content => body,
            reader_url => page.reader_url,
            nav => nav,
            eink => page.eink,
            theme => page.theme,
        },
    )
    .map_err(ApiError::internal)
}

fn query_suffix(eink: bool, theme: &'static str) -> String {
    let mut values = Vec::new();
    if eink {
        values.push("eink=1".to_owned());
    }
    if theme != "auto" {
        values.push(format!("theme={theme}"));
    }
    if values.is_empty() {
        String::new()
    } else {
        format!("?{}", values.join("&"))
    }
}

fn append_query(url: &str, query: &str) -> String {
    if query.is_empty() {
        url.to_owned()
    } else if url.contains('?') {
        format!("{url}&{}", query.trim_start_matches('?'))
    } else {
        format!("{url}{query}")
    }
}

fn split_reference(href: &str) -> Option<(String, String)> {
    let (path, fragment) = href
        .split_once('#')
        .map_or((href, ""), |(path, fragment)| (path, fragment));
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?;
    Some((decoded.into_owned(), fragment.to_owned()))
}

fn resolve_relative(current_path: &str, path: &str) -> Option<String> {
    let mut parts = current_path
        .rsplit_once('/')
        .map_or_else(Vec::new, |(dir, _)| {
            dir.split('/').filter(|part| !part.is_empty()).collect()
        });
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part if part.contains('\\') || part.contains(':') => return None,
            part => parts.push(part),
        }
    }
    let path = parts.join("/");
    (mutations::valid_file_path(&path) && delivery::included_path(&path)).then_some(path)
}

fn encode_component(value: &str) -> String {
    utf8_percent_encode(value, PATH_SET).to_string()
}

fn encode_path(value: &str) -> String {
    value
        .split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn first_h1_matches(markdown: &str, title: &str) -> bool {
    let markdown = strip_frontmatter(markdown);
    heading_metadata(markdown)
        .into_iter()
        .find(|heading| heading.level == 1)
        .is_some_and(|heading| heading.text.trim() == title.trim())
}

#[derive(Clone)]
struct HeadingMeta {
    id: String,
    level: u8,
    text: String,
}

fn heading_metadata(markdown: &str) -> Vec<HeadingMeta> {
    let mut result = Vec::new();
    let mut current: Option<(u8, Option<String>, String)> = None;
    let mut seen = BTreeMap::<String, usize>::new();
    for event in Parser::new_ext(markdown, options()) {
        match event {
            Event::Start(Tag::Heading { level, id, .. }) => {
                current = Some((
                    heading_level(level),
                    id.map(|id| id.into_string()),
                    String::new(),
                ));
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, _, text_out)) = current.as_mut() {
                    text_out.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, _, text_out)) = current.as_mut() {
                    text_out.push(' ');
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, explicit, text)) = current.take() {
                    let base = explicit
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| slugify(&text));
                    let count = seen.entry(base.clone()).or_default();
                    *count += 1;
                    let id = if *count == 1 {
                        base
                    } else {
                        format!("{base}-{count}")
                    };
                    result.push(HeadingMeta { id, level, text });
                }
            }
            _ => {}
        }
    }
    result
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn slugify(text: &str) -> String {
    let mut result = String::new();
    let mut dash = false;
    for character in text.trim().chars() {
        if character.is_alphanumeric() || character == '_' {
            result.push(character);
            dash = false;
        } else if (character.is_whitespace() || character == '-') && !result.is_empty() && !dash {
            result.push('-');
            dash = true;
        }
    }
    let result = result.trim_end_matches('-');
    if result.is_empty() {
        "section".to_owned()
    } else {
        result.to_owned()
    }
}

fn strip_frontmatter(markdown: &str) -> &str {
    let text = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let mut offset = 0;
    let mut opened = false;
    for line in text.split_inclusive('\n') {
        let marker = line.trim_end_matches(['\r', '\n']).trim();
        if marker == "---" {
            if opened {
                return &text[offset + line.len()..];
            }
            if offset == 0 {
                opened = true;
            }
        }
        offset += line.len();
    }
    text
}

fn options() -> Options {
    Options::ENABLE_GFM
        | Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_HEADING_ATTRIBUTES
}

fn render_markdown(markdown: &str, current_path: &str, links: &StaticLinks) -> String {
    let markdown = strip_frontmatter(markdown);
    let headings = heading_metadata(markdown);
    let mut renderer = Renderer {
        links,
        current_path,
        headings,
        heading_index: 0,
        out: String::new(),
        image: None,
        skip_link: 0,
        in_table_head: false,
        table_cell: 0,
        table_align: Vec::new(),
    };
    for event in Parser::new_ext(markdown, options()) {
        renderer.event(event);
    }
    renderer.out
}

struct ImageState {
    url: Option<String>,
    alt: String,
    title: String,
}

struct Renderer<'a> {
    links: &'a StaticLinks,
    current_path: &'a str,
    headings: Vec<HeadingMeta>,
    heading_index: usize,
    out: String,
    image: Option<ImageState>,
    skip_link: usize,
    in_table_head: bool,
    table_cell: usize,
    table_align: Vec<Alignment>,
}

impl Renderer<'_> {
    fn event(&mut self, event: Event<'_>) {
        if let Some(image) = self.image.as_mut() {
            match event {
                Event::Text(text) | Event::Code(text) => image.alt.push_str(&text),
                Event::SoftBreak => image.alt.push(' '),
                Event::HardBreak => image.alt.push('\n'),
                Event::End(TagEnd::Image) => {
                    let image = self.image.take().expect("image state");
                    if let Some(url) = image.url {
                        self.out.push_str("<img src=\"");
                        self.out.push_str(&escape(&url));
                        self.out.push_str("\" alt=\"");
                        self.out.push_str(&escape(&image.alt));
                        self.out.push_str("\" loading=\"lazy\" decoding=\"async\"");
                        if !image.title.is_empty() {
                            self.out.push_str(" title=\"");
                            self.out.push_str(&escape(&image.title));
                            self.out.push('"');
                        }
                        self.out.push('>');
                    } else {
                        self.out.push_str("<span class=\"image-alt\">");
                        self.out.push_str(&escape(&image.alt));
                        self.out.push_str("</span>");
                    }
                }
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.out.push_str(&escape(&text)),
            Event::Code(code) => {
                self.out.push_str("<code>");
                self.out.push_str(&escape(&code));
                self.out.push_str("</code>");
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                // Static reading deliberately treats raw HTML as text.
                self.out.push_str(&escape(&html));
            }
            Event::SoftBreak => self.out.push('\n'),
            Event::HardBreak => self.out.push_str("<br>"),
            Event::Rule => self.out.push_str("<hr>"),
            Event::TaskListMarker(checked) => {
                self.out.push_str(if checked {
                    "<input type=\"checkbox\" disabled checked>"
                } else {
                    "<input type=\"checkbox\" disabled>"
                });
            }
            Event::FootnoteReference(name) => {
                self.out.push_str("<sup class=\"footnote-ref\">[");
                self.out.push_str(&escape(&name));
                self.out.push_str("]</sup>");
            }
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                self.out.push_str(&escape(&math));
            }
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.out.push_str("<p>"),
            Tag::Heading { level, .. } => {
                let number = heading_level(level);
                let id = self
                    .headings
                    .get(self.heading_index)
                    .map(|heading| heading.id.clone())
                    .unwrap_or_else(|| "section".to_owned());
                self.heading_index += 1;
                self.out.push_str(&format!("<h{number} id=\""));
                self.out.push_str(&escape(&id));
                self.out.push_str("\">");
            }
            Tag::BlockQuote(kind) => {
                if kind.is_some() {
                    self.out.push_str("<blockquote class=\"quote-note\">");
                } else {
                    self.out.push_str("<blockquote>");
                }
            }
            Tag::CodeBlock(kind) => {
                self.out.push_str("<pre><code");
                if let CodeBlockKind::Fenced(info) = kind {
                    if let Some(language) = info.split_whitespace().next() {
                        self.out.push_str(" class=\"language-");
                        self.out.push_str(&escape(language));
                        self.out.push('"');
                    }
                }
                self.out.push('>');
            }
            Tag::List(start) => {
                if let Some(start) = start {
                    self.out.push_str("<ol");
                    if start != 1 {
                        self.out.push_str(&format!(" start=\"{start}\""));
                    }
                    self.out.push('>');
                } else {
                    self.out.push_str("<ul>");
                }
            }
            Tag::Item => self.out.push_str("<li>"),
            Tag::FootnoteDefinition(name) => {
                self.out.push_str("<section class=\"footnote\" id=\"fn-");
                self.out.push_str(&escape(&name));
                self.out.push_str("\">");
            }
            Tag::Table(align) => {
                self.table_align = align;
                self.out.push_str("<div class=\"table-scroll\"><table>");
            }
            Tag::TableHead => {
                self.in_table_head = true;
                self.table_cell = 0;
                self.out.push_str("<thead>");
            }
            Tag::TableRow => {
                self.table_cell = 0;
                self.out.push_str("<tr>");
            }
            Tag::TableCell => {
                let cell = if self.in_table_head { "th" } else { "td" };
                self.out.push('<');
                self.out.push_str(cell);
                match self.table_align.get(self.table_cell) {
                    Some(Alignment::Center) => self.out.push_str(" class=\"align-center\""),
                    Some(Alignment::Right) => self.out.push_str(" class=\"align-right\""),
                    _ => {}
                }
                self.out.push('>');
                self.table_cell += 1;
            }
            Tag::Emphasis => self.out.push_str("<em>"),
            Tag::Strong => self.out.push_str("<strong>"),
            Tag::Strikethrough => self.out.push_str("<del>"),
            Tag::Superscript => self.out.push_str("<sup>"),
            Tag::Subscript => self.out.push_str("<sub>"),
            Tag::Link {
                dest_url, title, ..
            } => {
                if let Some(target) = self.links.resolve(&dest_url, self.current_path, false) {
                    self.out.push_str("<a href=\"");
                    self.out.push_str(&escape(&target));
                    self.out.push_str("\" rel=\"noreferrer\"");
                    if !title.is_empty() {
                        self.out.push_str(" title=\"");
                        self.out.push_str(&escape(&title));
                        self.out.push('"');
                    }
                    self.out.push('>');
                } else {
                    self.skip_link += 1;
                }
            }
            Tag::Image {
                dest_url, title, ..
            } => {
                self.image = Some(ImageState {
                    url: self.links.resolve(&dest_url, self.current_path, true),
                    alt: String::new(),
                    title: title.into_string(),
                });
            }
            Tag::DefinitionList => self.out.push_str("<dl>"),
            Tag::DefinitionListTitle => self.out.push_str("<dt>"),
            Tag::DefinitionListDefinition => self.out.push_str("<dd>"),
            Tag::HtmlBlock | Tag::MetadataBlock(_) => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => self.out.push_str("</p>"),
            TagEnd::Heading(level) => {
                self.out.push_str(&format!("</h{}>", heading_level(level)));
            }
            TagEnd::BlockQuote(_) => self.out.push_str("</blockquote>"),
            TagEnd::CodeBlock => self.out.push_str("</code></pre>"),
            TagEnd::List(ordered) => {
                self.out.push_str(if ordered { "</ol>" } else { "</ul>" });
            }
            TagEnd::Item => self.out.push_str("</li>"),
            TagEnd::FootnoteDefinition => self.out.push_str("</section>"),
            TagEnd::Table => self.out.push_str("</table></div>"),
            TagEnd::TableHead => {
                self.in_table_head = false;
                self.out.push_str("</thead>");
            }
            TagEnd::TableRow => self.out.push_str("</tr>"),
            TagEnd::TableCell => {
                let cell = if self.in_table_head { "th" } else { "td" };
                self.out.push_str("</");
                self.out.push_str(cell);
                self.out.push('>');
            }
            TagEnd::Emphasis => self.out.push_str("</em>"),
            TagEnd::Strong => self.out.push_str("</strong>"),
            TagEnd::Strikethrough => self.out.push_str("</del>"),
            TagEnd::Superscript => self.out.push_str("</sup>"),
            TagEnd::Subscript => self.out.push_str("</sub>"),
            TagEnd::Link => {
                if self.skip_link > 0 {
                    self.skip_link -= 1;
                } else {
                    self.out.push_str("</a>");
                }
            }
            TagEnd::Image => {}
            TagEnd::DefinitionList => self.out.push_str("</dl>"),
            TagEnd::DefinitionListTitle => self.out.push_str("</dt>"),
            TagEnd::DefinitionListDefinition => self.out.push_str("</dd>"),
            TagEnd::HtmlBlock | TagEnd::MetadataBlock(_) => {}
        }
    }
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            character => out.push(character),
        }
    }
    out
}

async fn snapshot_reading(
    State(service): State<Arc<DocumentService>>,
    Path(snapshot): Path<String>,
    Query(query): Query<ReadingQuery>,
    headers: HeaderMap,
) -> Response {
    let next = format!("/r/{snapshot}/read");
    let eink = query.eink();
    let theme = query.theme();
    let result = documents::run(move || {
        let view = super::snapshots::snapshot_view(
            &service,
            &snapshot,
            query.document_id.as_deref(),
            &headers,
        )?;
        render(snapshot_static_page(&view, eink, theme))
    })
    .await;
    reading_response(result, &next)
}

async fn document_reading(
    State(service): State<Arc<DocumentService>>,
    Path((workspace, document)): Path<(String, String)>,
    Query(query): Query<ReadingQuery>,
    headers: HeaderMap,
) -> Response {
    let next = format!("/workspaces/{workspace}/documents/{document}/read");
    let eink = query.eink();
    let theme = query.theme();
    let result = documents::run(move || {
        let account = Account::authenticate(&service.spaces, &headers, false)?;
        let (instance, _, actual_workspace, path) =
            service.document_scope(&account, &document, false)?;
        if actual_workspace != workspace {
            return Err(ApiError::not_found());
        }
        let state = state(&instance)?;
        let _read = documents::product_read(state)?;
        let markdown = documents::read_markdown(state, &path)?;
        let title = documents::title_from_markdown(markdown.as_bytes())
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| {
                path.rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .trim_end_matches(".md")
                    .to_owned()
            });
        let mut documents = BTreeMap::new();
        let connection = service.metadata.connection()?;
        let mut statement =
            connection.prepare("SELECT id, path FROM documents WHERE workspace_id=?")?;
        let rows = statement.query_map([&actual_workspace], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, page_path): (String, String) = row?;
            documents.insert(
                page_path,
                format!(
                    "/workspaces/{}/documents/{}/read",
                    encode_component(&actual_workspace),
                    encode_component(&id)
                ),
            );
        }
        drop(statement);
        drop(connection);
        let assets = state
            .space
            .fetch_file_list()?
            .into_iter()
            .map(|file| file.name)
            .filter(|path| !documents::is_document_path(path) && delivery::included_path(path))
            .collect::<BTreeSet<_>>();
        render(document_static_page(DocumentPageInput {
            workspace: actual_workspace,
            document,
            title,
            markdown,
            path,
            documents,
            assets,
            eink,
            theme,
        }))
    })
    .await;
    reading_response(result, &next)
}

fn reading_response(result: Result<String, ApiError>, next: &str) -> Response {
    match result {
        Ok(html) => {
            let mut response = html.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            );
            headers.insert(
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            );
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(header::VARY, HeaderValue::from_static("Cookie"));
            response
        }
        Err(error) if error.status() == StatusCode::UNAUTHORIZED => Redirect::to(&format!(
            "/.auth/librarian/login?next={}",
            encode_component(next)
        ))
        .into_response(),
        Err(error) => error_page(error),
    }
}

fn error_page(error: ApiError) -> Response {
    let status = if error.status() == StatusCode::NOT_FOUND {
        StatusCode::NOT_FOUND
    } else {
        error.status()
    };
    let title = if status == StatusCode::NOT_FOUND {
        "阅读地址不可用"
    } else {
        "无法打开阅读页"
    };
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{title}</title><link rel=\"stylesheet\" href=\"/assets/static-reading.css\"></head><body><div class=\"page\"><main><article class=\"reading\"><h1>{title}</h1><p>请检查阅读地址是否仍然有效，或返回 Reader 重试。</p><p><a href=\"/\">返回 Librarian</a></p></article></main></div></body></html>"
    );
    let mut response = (status, html).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links() -> StaticLinks {
        StaticLinks {
            documents: BTreeMap::from([
                ("notes/other.md".to_owned(), "/notes/other".to_owned()),
                ("notes/photo.png".to_owned(), "/notes/photo".to_owned()),
            ]),
            assets: BTreeSet::from(["notes/photo.png".to_owned(), "notes/icon.svg".to_owned()]),
            asset_base: "/assets/".to_owned(),
            query: "?eink=1".to_owned(),
        }
    }

    fn page(markdown: &str) -> StaticPage {
        document_static_page(DocumentPageInput {
            workspace: "ws_test".to_owned(),
            document: "doc_test".to_owned(),
            title: "标题".to_owned(),
            markdown: markdown.to_owned(),
            path: "notes/note.md".to_owned(),
            documents: BTreeMap::new(),
            assets: BTreeSet::new(),
            eink: true,
            theme: "auto",
        })
    }

    #[test]
    fn renders_gfm_and_rewrites_local_links_and_images() {
        let html = render_markdown(
            "## 小标题\n\n| A | B |\n| - | -: |\n| 1 | 2 |\n\n[其他](other.md#段) ![图](photo.png) ![图标](icon.svg)\n\n- [x] 完成",
            "notes/note.md",
            &links(),
        );
        assert!(html.contains("<h2 id=\"小标题\">"), "{html}");
        assert!(html.contains("<table>"), "{html}");
        assert!(
            html.contains("<a href=\"/notes/other?eink=1#段\" rel=\"noreferrer\">其他</a>"),
            "{html}"
        );
        assert!(
            html.contains("<img src=\"/assets/notes/photo.png\""),
            "{html}"
        );
        assert!(html.contains("class=\"image-alt\">图标</span>"), "{html}");
        assert!(
            html.contains("type=\"checkbox\" disabled checked"),
            "{html}"
        );
    }

    #[test]
    fn escapes_raw_html_and_unsafe_urls() {
        let html = render_markdown(
            "<script>alert(1)</script>\n\n[坏](javascript:alert(1)) [远端](https://example.test/a) [数据](data:text/html,x)",
            "note.md",
            &links(),
        );
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(!html.contains("javascript:alert"), "{html}");
        assert!(
            html.contains("href=\"https://example.test/a\" rel=\"noreferrer\""),
            "{html}"
        );
        assert!(!html.contains("data:text/html"), "{html}");
    }

    #[test]
    fn hides_the_page_title_when_the_first_h1_is_the_title() {
        let html = render(page("# 标题\n\n正文。\n")).unwrap();
        assert_eq!(html.matches("<h1").count(), 1, "{html}");
        assert!(html.contains("正文。"), "{html}");
        assert!(
            html.contains("<html lang=\"zh-CN\" class=\"theme-auto eink\">"),
            "{html}"
        );
        assert!(!html.contains("<script"), "{html}");
    }

    #[test]
    fn strips_front_matter_with_crlf() {
        let html = render_markdown(
            "---\r\ntitle: 元数据\r\n---\r\n\r\n# 正文\r\n",
            "note.md",
            &links(),
        );
        assert!(!html.contains("title: 元数据"), "{html}");
        assert!(html.contains("正文"), "{html}");
    }
}
