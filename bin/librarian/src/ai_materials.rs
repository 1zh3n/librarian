//! Local parser child. All source data arrives on stdin. No relationships,
//! hyperlinks, embedded objects or PDF actions are opened or executed.
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    io::{self, Cursor, Read},
    path::Component,
};

use silverbullet_server::product::ai_materials::segment::{
    Location, ParseResult, Segment, FILE_LIMIT, SEGMENT_BYTES, SEGMENT_LIMIT, TEXT_LIMIT,
};

const EXPANSION_LIMIT: usize = 50 * 1024 * 1024;
const WML: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WML: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";
type Parsed<T> = Result<T, &'static str>;

pub(super) fn worker(format: &str) -> io::Result<()> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(FILE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    let result = match extract(format, &bytes) {
        Ok(segments) => ParseResult::Ready { segments },
        Err(code) => ParseResult::Failed {
            error_code: code.into(),
        },
    };
    serde_json::to_writer(io::stdout().lock(), &result).map_err(io::Error::other)
}

#[derive(Default)]
struct Extract {
    segments: Vec<Segment>,
    size: usize,
}

impl Extract {
    fn push(&mut self, text: &str, index: u32, pdf: bool) -> Parsed<()> {
        let mut text = text.trim();
        self.size += text.len();
        if self.size > TEXT_LIMIT {
            return Err("extraction_limit");
        }
        while !text.is_empty() {
            if self.segments.len() >= SEGMENT_LIMIT {
                return Err("extraction_limit");
            }
            let end = text.floor_char_boundary(text.len().min(SEGMENT_BYTES));
            self.segments.push(Segment {
                location: Location {
                    segment_id: format!("s{}", self.segments.len() + 1),
                    page: pdf.then_some(index),
                    paragraph_start: (!pdf).then_some(index),
                    paragraph_end: (!pdf).then_some(index),
                },
                text: text[..end].to_owned(),
            });
            text = &text[end..];
        }
        Ok(())
    }
}

fn extract(kind: &str, bytes: &[u8]) -> Parsed<Vec<Segment>> {
    if bytes.len() > FILE_LIMIT {
        return Err("file_too_large");
    }
    let pdf = bytes.starts_with(b"%PDF-");
    let zip = bytes.starts_with(b"PK\x03\x04");
    let mut out = Extract::default();
    match kind {
        "pdf" if pdf => {
            let doc = lopdf::Document::load_mem(bytes).map_err(|_| "invalid_file")?;
            if doc.is_encrypted() || doc.was_encrypted() {
                return Err("encrypted_pdf");
            }
            for page in doc.get_pages().into_keys() {
                let text = doc.extract_text(&[page]).map_err(|_| "invalid_file")?;
                out.push(&text, page, true)?;
            }
        }
        "docx" if zip => docx(bytes, &mut out)?,
        "txt" | "md" if !zip && !pdf => {
            let text = decode(bytes).ok_or("type_mismatch")?;
            if text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\t' | '\r' | '\n' | '\u{c}'))
            {
                return Err("type_mismatch");
            }
            let text = text
                .trim_start_matches('\u{feff}')
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            let mut index = 0;
            let mut lines = Vec::new();
            for line in text.lines().chain(std::iter::once("")) {
                if line.trim().is_empty() {
                    if !lines.is_empty() {
                        index += 1;
                        out.push(&lines.join("\n"), index, false)?;
                        lines.clear();
                    }
                } else {
                    lines.push(line);
                }
            }
        }
        _ => return Err("type_mismatch"),
    }
    if out.segments.is_empty() {
        return Err("no_text");
    }
    Ok(out.segments)
}

fn docx(bytes: &[u8], out: &mut Extract) -> Parsed<()> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "invalid_file")?;
    if zip.len() > 16_384 {
        return Err("expansion_limit");
    }
    let mut total = 0;
    let mut seen = HashSet::new();
    let mut parts: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|_| "invalid_file")?;
        let name = entry.name().to_owned();
        if entry.enclosed_name().is_none()
            || name.contains(['\\', ':'])
            || std::path::Path::new(&name)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || !seen.insert(name.clone())
        {
            return Err("invalid_file");
        }
        let remaining = (EXPANSION_LIMIT - total) as u64;
        if entry.size() > remaining {
            return Err("expansion_limit");
        }
        let mut reader = entry.take(remaining + 1);
        let count = if name.ends_with(".xml") || name == "_rels/.rels" {
            io::copy(&mut reader, parts.entry(name).or_default())
        } else {
            io::copy(&mut reader, &mut io::sink())
        }
        .map_err(|_| "invalid_file")?;
        if count > remaining {
            return Err("expansion_limit");
        }
        total += count as usize;
    }
    let part = |name: &str| {
        parts
            .get(name)
            .and_then(|bytes| decode(bytes))
            .ok_or("invalid_file")
    };
    let relationships = part("_rels/.rels")?;
    let rels = xml(&relationships)?;
    let target = rels.descendants().find(|node| {
        node.has_tag_name(("http://schemas.openxmlformats.org/package/2006/relationships", "Relationship"))
            && matches!(node.attribute("Type"),
                Some("http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
                | "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"))
    }).ok_or("type_mismatch")?;
    if target
        .attribute("TargetMode")
        .is_some_and(|mode| mode != "Internal")
    {
        return Err("invalid_file");
    }
    let name = target
        .attribute("Target")
        .ok_or("invalid_file")?
        .trim_start_matches('/');
    let declared = format!("/{name}");
    let types = part("[Content_Types].xml")?;
    if !xml(&types)?.descendants().any(|node| {
        node.has_tag_name(("http://schemas.openxmlformats.org/package/2006/content-types", "Override"))
        && node.attribute("PartName") == Some(declared.as_str())
        && node.attribute("ContentType") == Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")
    }) {
        return Err("type_mismatch");
    }
    let document = part(name)?;
    let doc = xml(&document)?;
    let ns = doc
        .root_element()
        .tag_name()
        .namespace()
        .ok_or("invalid_file")?;
    if !matches!(ns, WML | STRICT_WML) || !doc.root_element().has_tag_name((ns, "document")) {
        return Err("type_mismatch");
    }
    let body = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name((ns, "body")))
        .ok_or("invalid_file")?;
    for (i, p) in body
        .descendants()
        .filter(|n| n.has_tag_name((ns, "p")))
        .enumerate()
    {
        let mut text = String::new();
        for node in p
            .descendants()
            .skip(1)
            .filter(|n| n.is_element() && n.tag_name().namespace() == Some(ns))
        {
            match node.tag_name().name() {
                "t" => text.push_str(node.text().unwrap_or("")),
                "tab" => text.push('\t'),
                "br" | "cr" => text.push('\n'),
                _ => {}
            }
        }
        out.push(&text, (i + 1) as u32, false)?;
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Option<Cow<'_, str>> {
    let (tail, units) = if let Some(tail) = bytes.strip_prefix(&[0xff, 0xfe]) {
        (tail, u16::from_le_bytes as fn([u8; 2]) -> u16)
    } else if let Some(tail) = bytes.strip_prefix(&[0xfe, 0xff]) {
        (tail, u16::from_be_bytes as fn([u8; 2]) -> u16)
    } else {
        return std::str::from_utf8(bytes).ok().map(Cow::Borrowed);
    };
    let (pairs, remainder) = tail.as_chunks::<2>();
    if !remainder.is_empty() {
        return None;
    }
    char::decode_utf16(pairs.iter().copied().map(units))
        .collect::<Result<String, _>>()
        .ok()
        .map(Cow::Owned)
}

fn xml(text: &str) -> Parsed<roxmltree::Document<'_>> {
    roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            nodes_limit: 1_000_000,
            ..Default::default()
        },
    )
    .map_err(|_| "invalid_file")
}
