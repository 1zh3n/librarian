use std::{
    io::{Cursor, Write},
    process::{Command, Stdio},
};

use serde_json::Value;
use zip::{write::SimpleFileOptions, ZipWriter};

fn parse(kind: &str, bytes: &[u8]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_librarian"))
        .args(["material-parser", kind])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(bytes);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "parser did not return a classified result: {}",
        output.status
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn parses_four_formats_with_canonical_locations() {
    for (kind, bytes, text, location) in [
        (
            "txt",
            include_bytes!("fixtures/ai-materials/notes.txt").as_slice(),
            "样本在北区。",
            "paragraphStart",
        ),
        (
            "md",
            include_bytes!("fixtures/ai-materials/agenda.md").as_slice(),
            "请核对十月指标。",
            "paragraphStart",
        ),
        (
            "docx",
            include_bytes!("fixtures/ai-materials/meeting.docx").as_slice(),
            "复核数字为四十二。",
            "paragraphStart",
        ),
        (
            "pdf",
            include_bytes!("fixtures/ai-materials/budget.pdf").as_slice(),
            "预算为七十。",
            "page",
        ),
    ] {
        let result = parse(kind, bytes);
        let segment = &result["segments"][1];
        assert_eq!(segment["text"], text, "{kind}: {result}");
        assert_eq!(segment[location], 2);
        assert_eq!(segment["segmentId"], "s2");
    }
}

#[test]
fn rejects_oversize_and_type_mismatch() {
    assert_eq!(parse("txt", b"%PDF-1.4\n")["errorCode"], "type_mismatch");
    assert_eq!(parse("pdf", b"%PDF-1.4\n")["errorCode"], "invalid_file");
    assert_eq!(parse("md", b"\0data")["errorCode"], "type_mismatch");
    assert_eq!(parse("docx", b"document")["errorCode"], "type_mismatch");
    assert_eq!(
        parse("txt", &vec![b'a'; 10 * 1024 * 1024 + 1])["errorCode"],
        "file_too_large"
    );
}

#[test]
fn bounds_document_expansion_and_extraction() {
    assert_eq!(
        parse("txt", &vec![b'a'; 512 * 1024 + 1])["errorCode"],
        "extraction_limit"
    );
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(
        "word/media/blank",
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .unwrap();
    for _ in 0..51 {
        zip.write_all(&vec![0; 1024 * 1024]).unwrap();
    }
    assert_eq!(
        parse("docx", &zip.finish().unwrap().into_inner())["errorCode"],
        "expansion_limit"
    );
}
