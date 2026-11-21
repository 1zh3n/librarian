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

use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use serde_json::json;
use silverbullet_server::multi::users::{Profile, UserStore};
use std::{fs, time::Duration};
use tempfile::TempDir;
use tower::ServiceExt;

struct Site {
    root: TempDir,
    app: Router,
    token: String,
    peer: String,
    workspace: String,
}
impl Site {
    async fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        let token = |name| {
            users
                .create_user(name, "synthetic-password", false, Profile::default())
                .unwrap();
            users.create_token(name, "test").unwrap()
        };
        let (owner, peer) = (token("owner"), token("peer"));
        fs::create_dir_all(root.path().join("spaces/notes")).unwrap();
        fs::write(root.path().join("spaces.json"), json!({"notes":{"name":"Notes","binding":{"prefix":"/notes"},"access":"none","revisions":"managed","members":{"owner":{"role":"write"},"peer":{"role":"read"}}}}).to_string()).unwrap();
        let app = librarian::Product::open(root.path(), 0).unwrap().router();
        let mut site = Self {
            root,
            app,
            token: owner,
            peer,
            workspace: String::new(),
        };
        site.workspace = site.get("/workspaces").await[0]["id"]
            .as_str()
            .unwrap()
            .into();
        site
    }
    async fn request(
        &self,
        token: &str,
        method: &str,
        path: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> (u16, Value) {
        let res = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", mime)
                    .body(Body::from(bytes))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = to_bytes(res.into_body(), 2_000_000).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn get(&self, path: &str) -> Value {
        let (s, v) = self
            .request(&self.token, "GET", path, "application/json", vec![])
            .await;
        assert_eq!(s, 200, "{path} {v}");
        v
    }
    async fn conversation(&self) -> String {
        let (s, v) = self
            .request(
                &self.token,
                "POST",
                "/ai/conversations",
                "application/json",
                json!({"workspaceId":self.workspace})
                    .to_string()
                    .into_bytes(),
            )
            .await;
        assert_eq!(s, 201, "{v}");
        format!("/ai/conversations/{}/materials", v["id"].as_str().unwrap())
    }
    async fn upload(&self, base: &str, name: &str, mime: &str, bytes: Vec<u8>) -> Value {
        let (s, v) = self
            .request(
                &self.token,
                "POST",
                &format!("{base}?name={name}"),
                mime,
                bytes,
            )
            .await;
        assert_eq!(s, 202, "{v}");
        v
    }
    async fn ready(&self, base: &str, id: &str) {
        for _ in 0..200 {
            let list = self.get(base).await;
            let material = list
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == id)
                .unwrap();
            assert_ne!(material["status"], "failed", "{material}");
            if material["status"] == "ready" {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("material did not become ready");
    }
    fn reopen(&mut self) {
        self.app = Router::new();
        self.app = librarian::Product::open(self.root.path(), 0)
            .unwrap()
            .router();
    }
}

#[tokio::test]
async fn lists_only_authorized_locations_and_reads_the_stable_segment() {
    let mut f = Site::open().await;
    let base = f.conversation().await;
    let other = f.conversation().await;
    let paragraphs = (1..=40)
        .map(|i| format!("段落 {i}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let m = f
        .upload(
            &base,
            "%E7%AC%94%E8%AE%B0.txt",
            "text/plain",
            paragraphs.into_bytes(),
        )
        .await;
    assert_eq!(m["name"], "笔记.txt");
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let path = format!("{base}/{id}/segments");
    let page = f.get(&path).await;
    let next = page["nextCursor"].as_str().unwrap();
    assert!(page["items"][0].get("text").is_none());
    let next_page = f.get(&format!("{path}?cursor={next}")).await;
    assert_ne!(page["items"][0], next_page["items"][0]);
    let found = f.get(&format!("{path}?q=37")).await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    let sid = found["items"][0]["segmentId"].as_str().unwrap();
    assert_eq!(found["items"][0]["paragraphStart"], 37);
    for suffix in ["".to_owned(), format!("/{sid}")] {
        assert_eq!(
            f.request(
                &f.peer,
                "GET",
                &format!("{path}{suffix}"),
                "text/plain",
                vec![]
            )
            .await
            .0,
            404
        );
        assert_eq!(
            f.request(
                &f.token,
                "GET",
                &format!("{other}/{id}/segments{suffix}"),
                "text/plain",
                vec![]
            )
            .await
            .0,
            404
        );
    }
    f.reopen();
    assert_eq!(f.get(&format!("{path}/{sid}")).await["text"], "段落 37");
    assert_eq!(
        f.request(
            &f.token,
            "DELETE",
            &format!("{base}/{id}"),
            "text/plain",
            vec![]
        )
        .await
        .0,
        204
    );
    assert_eq!(
        f.request(&f.token, "GET", &path, "text/plain", vec![])
            .await
            .0,
        404
    );
}

#[tokio::test]
async fn expires_and_reconciles_orphans_after_restart() {
    let mut f = Site::open().await;
    let base = f.conversation().await;
    let m = f
        .upload(
            &base,
            "private.md",
            "text/markdown",
            b"private only".to_vec(),
        )
        .await;
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let dir = f.root.path().join(".librarian/ai-materials");
    assert!(dir.join(format!("{id}.raw")).is_file());
    fs::write(dir.join("abandoned.raw"), "partial").unwrap();
    rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3"))
        .unwrap()
        .execute("UPDATE ai_materials SET expires_at=0 WHERE id=?1", [id])
        .unwrap();
    f.reopen();
    assert_eq!(f.get(&base).await, json!([]));
    assert_eq!(fs::read_dir(dir).unwrap().count(), 0);
    assert!(!f.root.path().join("spaces/notes/private.md").exists());
}

#[tokio::test]
async fn checks_authority_and_mime_before_accepting_file_body() {
    let f = Site::open().await;
    let base = f.conversation().await;
    assert_eq!(
        f.request(
            &f.peer,
            "POST",
            &format!("{base}?name=n.txt"),
            "text/plain",
            vec![0]
        )
        .await
        .0,
        404
    );
    assert_eq!(
        f.request(
            &f.token,
            "POST",
            &format!("{base}?name=n.pdf"),
            "text/plain",
            vec![]
        )
        .await
        .0,
        415
    );
    assert_eq!(
        f.request(
            &f.token,
            "POST",
            &format!("{base}?name=n.txt"),
            "text/plain",
            vec![1; 10 * 1024 * 1024 + 1]
        )
        .await
        .0,
        413
    );
    assert_eq!(f.get(&base).await, json!([]));
}

#[tokio::test]
async fn binds_ready_selection_once_and_rolls_back_invalid_batches() {
    let f = Site::managed().await;
    let base = f.conversation().await;
    let turns = base.replace("/materials", "/turns");
    let first = f
        .upload(&base, "sample.txt", "text/plain", b"selected text".to_vec())
        .await;
    let id = first["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let original = first["expiresAt"].as_i64().unwrap();
    let send = |ids: Value| {
        json!({"mode":"chat","prompt":"compare","clientTurnId":"sample","materialIds":ids})
            .to_string()
            .into_bytes()
    };
    for invalid in [
        json!([id, id]),
        json!([id, "unknown"]),
        json!(["1", "2", "3", "4", "5", "6"]),
    ] {
        let (status, _) = f
            .request(&f.token, "POST", &turns, "application/json", send(invalid))
            .await;
        assert!((400..500).contains(&status));
    }
    assert_eq!(f.get(&base).await[0]["expiresAt"], original);
    let selected = send(json!([id]));
    let (s, turn) = f
        .request(
            &f.token,
            "POST",
            &turns,
            "application/json",
            selected.clone(),
        )
        .await;
    assert_eq!(s, 202, "{turn}");
    let expires = f.get(&base).await[0]["expiresAt"].as_i64().unwrap();
    assert!((6 * 86400..=6 * 86400 + 20).contains(&(expires - original)));
    assert_eq!(
        f.request(&f.token, "POST", &turns, "application/json", selected)
            .await
            .1["id"],
        turn["id"]
    );
}

#[tokio::test]
async fn deleting_conversation_immediately_clears_originals_and_segments() {
    let f = Site::open().await;
    let base = f.conversation().await;
    let m = f
        .upload(
            &base,
            "sample.txt",
            "text/plain",
            b"ephemeral sample".to_vec(),
        )
        .await;
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let path = base.strip_suffix("/materials").unwrap();
    let status = f
        .request(&f.token, "DELETE", path, "application/json", vec![])
        .await
        .0;
    assert_eq!(status, 204);
    let dir = f.root.path().join(".librarian/ai-materials");
    assert!(!dir.join(format!("{id}.raw")).exists());
    assert!(!dir.join(format!("{id}.json")).exists());
}

#[tokio::test]
async fn rejects_more_than_25_mib_without_extending_any_expiry() {
    let f = Site::managed().await;
    let base = f.conversation().await;
    let mut bytes = vec![b' '; 9 * 1024 * 1024];
    bytes[..4].copy_from_slice(b"note");
    let mut ids = Vec::new();
    for name in ["a.txt", "b.txt", "c.txt"] {
        let m = f.upload(&base, name, "text/plain", bytes.clone()).await;
        let id = m["id"].as_str().unwrap();
        f.ready(&base, id).await;
        ids.push(id.to_owned());
    }
    let before = f.get(&base).await;
    let result = f
        .request(
            &f.token,
            "POST",
            &base.replace("/materials", "/turns"),
            "application/json",
            json!({"mode":"chat","prompt":"compare","clientTurnId":"batch","materialIds":ids})
                .to_string()
                .into_bytes(),
        )
        .await;
    assert_eq!(result.0, 422);
    assert_eq!(f.get(&base).await, before);
}

#[test]
fn distinguishes_encrypted_and_image_only_pdf() {
    use lopdf::{Document, EncryptionState, EncryptionVersion, Object, Permissions, StringFormat};
    let src = include_bytes!("fixtures/ai-materials/budget.pdf");
    let mut blank = src.to_vec();
    for i in 0..blank.len() - 5 {
        if &blank[i..i + 5] == b"Tj ET" {
            blank[i..i + 2].copy_from_slice(b"  ");
        }
    }
    assert_eq!(parse("pdf", &blank)["errorCode"], "no_text");
    let mut doc = Document::load_mem(src).unwrap();
    doc.trailer.set(
        "ID",
        Object::Array(vec![
            Object::String(vec![1; 16], StringFormat::Literal),
            Object::String(vec![2; 16], StringFormat::Literal),
        ]),
    );
    let encryption = EncryptionVersion::V2 {
        document: &doc,
        owner_password: "synthetic-owner",
        user_password: "synthetic-reader",
        key_length: 128,
        permissions: Permissions::all(),
    };
    doc.encrypt(&EncryptionState::try_from(encryption).unwrap())
        .unwrap();
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    assert_eq!(parse("pdf", &bytes)["errorCode"], "encrypted_pdf");
}

#[tokio::test]
async fn omits_expired_material_excerpt_from_next_request() {
    let mut f = Site::managed().await;
    let base = f.conversation().await;
    let m = f
        .upload(
            &base,
            "notes.txt",
            "text/plain",
            b"private historical material".to_vec(),
        )
        .await;
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let turns = base.replace("/materials", "/turns");
    let send = |n, ids: Value| {
        json!({"mode":"chat","prompt":format!("round {n}"),"clientTurnId":format!("test-{n}"),"materialIds":ids}).to_string().into_bytes()
    };
    for n in 1..=2 {
        let ids = if n == 1 { json!([id]) } else { json!([]) };
        let turn = f
            .request(&f.token, "POST", &turns, "application/json", send(n, ids))
            .await;
        assert_eq!(turn.0, 202, "{}", turn.1);
        let (status, claim) = f.runner("POST", "claims", json!({})).await;
        assert_eq!(status, 200, "{claim}");
        let lease = claim["leaseId"].as_str().unwrap();
        let mut sources = vec![];
        if n == 1 {
            let (status, read) = f
                .runner(
                    "GET",
                    &format!("claims/{lease}/materials/{id}/segments/s1"),
                    Value::Null,
                )
                .await;
            assert_eq!(status, 200, "{read}");
            sources.push(read["source"]["id"].as_str().unwrap().to_owned());
        } else {
            assert_eq!(
                claim["input"]["history"][0]["answer"],
                "historical excerpt 1"
            );
        }
        let (s, receipt) = f
            .runner(
                "PUT",
                &format!("claims/{lease}/result"),
                json!({"answer":format!("historical excerpt {n}"),"edits":[],"sourceIds":sources}),
            )
            .await;
        assert_eq!(s, 200, "{receipt}");
    }
    rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3"))
        .unwrap()
        .execute("UPDATE ai_materials SET expires_at=0 WHERE id=?", [id])
        .unwrap();
    f.reopen();
    assert_eq!(
        f.request(
            &f.token,
            "POST",
            &turns,
            "application/json",
            send(3, json!([]))
        )
        .await
        .0,
        202
    );
    let (status, claim) = f.runner("POST", "claims", json!({})).await;
    assert_eq!(status, 200, "{claim}");
    assert_eq!(claim["input"]["history"], json!([]));
    assert!(!claim.to_string().contains("historical excerpt"));
    let history = f.get(&turns).await;
    assert!(history.to_string().contains("historical excerpt 1"));
    assert!(history.to_string().contains("historical excerpt 2"));
}

#[path = "fixtures/ai-materials/setup.rs"]
mod managed;

impl Site {
    async fn managed() -> Self {
        let mut site = Self::open().await;
        fs::write(
            site.root.path().join(".librarian/ai-test-loopback"),
            "127.0.0.1:9",
        )
        .unwrap();
        managed::configure(site.root.path()).unwrap();
        site.reopen();
        site
    }

    async fn runner(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let res = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1/ai/runner/v2/{path}"))
                    .header("authorization", format!("Bearer {}", managed::RUNNER))
                    .header("x-librarian-runner-id", managed::INSTANCE)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = to_bytes(res.into_body(), 1_000_000).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

#[tokio::test]
async fn cites_only_material_segments_actually_read() {
    let f = Site::managed().await;
    let base = f.conversation().await;
    let mut ids = vec![];
    for (name, bytes) in [
        (
            "one.pdf",
            include_bytes!("fixtures/ai-materials/budget.pdf").as_slice(),
        ),
        (
            "two.docx",
            include_bytes!("fixtures/ai-materials/meeting.docx").as_slice(),
        ),
        ("unselected.txt", b"private".as_slice()),
    ] {
        let m = f
            .upload(&base, name, "application/octet-stream", bytes.to_vec())
            .await;
        let id = m["id"].as_str().unwrap();
        f.ready(&base, id).await;
        ids.push(id.to_owned());
    }
    let (status,turn)=f.request(&f.token,"POST",&base.replace("/materials","/turns"),"application/json",
        json!({"mode":"chat","prompt":"比较数字","clientTurnId":"numbers","materialIds":&ids[..2]}).to_string().into_bytes()).await;
    assert_eq!(status, 202, "{turn}");
    let (status, claim) = f.runner("POST", "claims", json!({})).await;
    assert_eq!(status, 200, "{claim}");
    let input = &claim["input"]["materials"];
    assert_eq!(input.as_array().unwrap().len(), 2);
    assert!(!claim.to_string().contains("预算为七十"));
    let lease = claim["leaseId"].as_str().unwrap();
    let prefix = format!("claims/{lease}");
    let unselected = format!("{prefix}/materials/{}/segments", ids[2]);
    assert_eq!(f.runner("GET", &unselected, Value::Null).await.0, 404);
    let mut sources = Vec::new();
    for (index, keyword, original) in [
        (0, "%E9%A2%84%E7%AE%97", "预算为七十。"),
        (1, "%E5%A4%8D%E6%A0%B8", "复核数字为四十二。"),
    ] {
        let path = format!("{prefix}/materials/{}/segments", ids[index]);
        let (s, catalog) = f
            .runner("GET", &format!("{path}?q={keyword}"), Value::Null)
            .await;
        assert_eq!(s, 200, "{catalog}");
        assert_eq!(catalog["items"].as_array().unwrap().len(), 1);
        let item = &catalog["items"][0];
        assert!(item.get("text").is_none());
        let sid = item["segmentId"].as_str().unwrap();
        let forged = json!({"answer":"invalid","sourceIds":[sid],"edits":[]});
        assert_eq!(
            f.runner("PUT", &format!("{prefix}/result"), forged).await.0,
            422
        );
        let (s, read) = f.runner("GET", &format!("{path}/{sid}"), Value::Null).await;
        assert_eq!(s, 200, "{read}");
        assert_eq!(read["text"], original);
        assert_eq!(read["source"]["kind"], "material");
        assert_eq!(read["source"]["materialId"], ids[index]);
        assert_eq!(
            read["source"][if index == 0 { "page" } else { "paragraphStart" }],
            2
        );
        assert!(read["source"].get("documentId").is_none());
        sources.push(read["source"]["id"].as_str().unwrap().to_owned());
    }
    let (s, receipt) = f
        .runner(
            "PUT",
            &format!("{prefix}/result"),
            json!({"answer":"已核对。","sourceIds":sources,"edits":[]}),
        )
        .await;
    assert_eq!(s, 200, "{receipt}");
    assert_eq!(receipt["sources"].as_array().unwrap().len(), 2);
    assert_ne!(
        f.runner(
            "GET",
            &format!("{prefix}/materials/{}/segments", ids[0]),
            Value::Null
        )
        .await
        .0,
        200
    );
}

#[tokio::test]
async fn recovers_interrupted_job_and_rechecks_workspace_membership_on_every_read() {
    let mut f = Site::open().await;
    let base = f.conversation().await;
    let m = f
        .upload(
            &base,
            "private.md",
            "text/markdown",
            b"unique private excerpt".to_vec(),
        )
        .await;
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let path = format!("{base}/{id}/segments");
    let sid = f.get(&path).await["items"][0]["segmentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let dir = f.root.path().join(".librarian");
    fs::remove_file(dir.join(format!("ai-materials/{id}.json"))).unwrap();
    rusqlite::Connection::open(dir.join("metadata.sqlite3"))
        .unwrap()
        .execute("UPDATE ai_materials SET status='working' WHERE id=?", [id])
        .unwrap();
    assert_eq!(
        f.request(&f.token, "GET", &path, "application/json", vec![])
            .await
            .0,
        409
    );
    f.reopen();
    f.ready(&base, id).await;
    assert_eq!(
        f.get(&format!("{path}/{sid}")).await["text"],
        "unique private excerpt"
    );
    let config = f.root.path().join("spaces.json");
    let mut spaces: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    spaces["notes"]["members"]
        .as_object_mut()
        .unwrap()
        .remove("owner");
    fs::write(config, spaces.to_string()).unwrap();
    f.reopen();
    for resource in [&base, &path, &format!("{path}/{sid}")] {
        assert_eq!(
            f.request(&f.token, "GET", resource, "application/json", vec![])
                .await
                .0,
            404
        );
    }
}

#[tokio::test]
async fn enforces_the_shared_document_and_material_lease_budget() {
    let f = Site::managed().await;
    let doc = f
        .request(
            &f.token,
            "POST",
            &format!("/workspaces/{}/documents", f.workspace),
            "application/json",
            json!({"path":"source.md","baseRevision":null,"markdown":"a".repeat(248*1024)})
                .to_string()
                .into_bytes(),
        )
        .await;
    assert_eq!(doc.0, 201);
    let base = f.conversation().await;
    let m = f
        .upload(&base, "long.txt", "text/plain", vec![b'a'; 8193])
        .await;
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let turn = f
        .request(
            &f.token,
            "POST",
            &base.replace("/materials", "/turns"),
            "application/json",
            json!({"mode":"chat","clientTurnId":"budget","prompt":"read","materialIds":[id]})
                .to_string()
                .into_bytes(),
        )
        .await;
    assert_eq!(turn.0, 202);
    let claim = f.runner("POST", "claims", json!({})).await;
    assert_eq!(claim.0, 200);
    let lease = claim.1["leaseId"].as_str().unwrap();
    let doc = f
        .runner(
            "POST",
            &format!("claims/{lease}/sources"),
            json!({"documentId":doc.1["document"]["id"],"full":true}),
        )
        .await;
    assert_eq!(doc.0, 200);
    let path = format!("claims/{lease}/materials/{id}/segments");
    let first = f.runner("GET", &format!("{path}/s1"), Value::Null).await;
    assert_eq!(first.0, 200);
    assert_eq!(first.1["text"].as_str().unwrap().len(), 8192);
    assert_eq!(f.runner("GET", &path, Value::Null).await.0, 200);
    let extra = f.runner("GET", &format!("{path}/s2"), Value::Null).await;
    assert_eq!(extra.0, 422);
    assert_eq!(extra.1["code"], "source_limit");
}

#[test]
fn handles_bom_text_and_local_ooxml_main_parts() {
    let utf16 = |value: &str| {
        [
            vec![0xff, 0xfe],
            value.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat()
    };
    assert_eq!(
        parse("txt", &utf16("甲\r\n\r\n乙"))["segments"][1]["text"],
        "乙"
    );
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();
    for (name, content) in [
        (
            "[Content_Types].xml",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/parts/main.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="parts/main.xml"/></Relationships>"#,
        ),
        (
            "parts/main.xml",
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>本地部件</w:t></w:r></w:p></w:body></w:document>"#,
        ),
    ] {
        zip.start_file(name, opts).unwrap();
        zip.write_all(&utf16(content)).unwrap();
    }
    assert_eq!(
        parse("docx", &zip.finish().unwrap().into_inner())["segments"][0]["text"],
        "本地部件"
    );
}

#[tokio::test]
async fn legacy_accepts_plain_turns_and_drafts_but_requires_managed_material_analysis() {
    let f = Site::open().await;
    let base = f.conversation().await;
    let m = f
        .upload(&base, "draft.txt", "text/plain", b"still private".to_vec())
        .await;
    let id = m["id"].as_str().unwrap();
    f.ready(&base, id).await;
    let turns = base.replace("/materials", "/turns");
    let send = |ids: Value| {
        json!({"mode":"chat","clientTurnId":"legacy-test","prompt":"compare","materialIds":ids})
            .to_string()
            .into_bytes()
    };
    let (status, error) = f
        .request(
            &f.token,
            "POST",
            &turns,
            "application/json",
            send(json!([id])),
        )
        .await;
    assert_eq!(status, 409, "{error}");
    assert_eq!(error["code"], "managed_activation_required");
    assert_eq!(f.get(&base).await[0]["expiresAt"], m["expiresAt"]);
    assert_eq!(
        f.get(&format!("{base}/{id}/segments/s1")).await["text"],
        "still private"
    );
    let (status, turn) = f
        .request(
            &f.token,
            "POST",
            &turns,
            "application/json",
            send(json!([])),
        )
        .await;
    assert_eq!(status, 202, "{turn}");
}
