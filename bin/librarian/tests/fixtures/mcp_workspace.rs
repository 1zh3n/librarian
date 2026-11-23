use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

async fn workspace(server: &Server, who: &Session) -> String {
    server.tool(who, "workspace_list", json!({})).await["structuredContent"]["workspaces"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

const OP: &str = "86f1927a-4cf8-4924-aa63-a8e1307afba5";
const IMAGE: &[u8] = include_bytes!("../../../../server/testdata/images/tiny.png");

#[tokio::test]
async fn mcp_reader_url_uses_trusted_public_base() {
    let base = "https://read.example.org/librarian";
    let server = Server::with_reader_base(Some(base)).await;
    let who = server.connect("alice", "left").await;
    let ws = workspace(&server, &who).await;
    let files = json!([{"path":"方案.md","contentBase64":STANDARD.encode("原文\r\n![图](img.png)\r\n")},
                       {"path":"img.png","contentBase64":STANDARD.encode(IMAGE)}]);
    let upload =
        json!({"workspaceId":ws,"targetDirectory":"项目甲","operationId":OP,"files":files});
    let response = server.client.post(format!("{}/.mcp",server.url)).bearer_auth(&who.access)
        .header(header::ACCEPT,"application/json, text/event-stream")
        .header("Forwarded","host=untrusted.example;proto=https").header("X-Forwarded-Host","untrusted.example")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workspace_upload_files","arguments":upload}})).send().await.unwrap();
    let result = response.json::<Value>().await.unwrap()["result"].clone();
    assert_ne!(result["isError"], true, "{result}");
    let receipt = &result["structuredContent"];
    let document = &receipt["documents"][0];
    let id = document["documentId"].as_str().unwrap();
    let path = format!("/workspaces/{ws}/documents/{id}");
    assert_eq!(document["path"], "项目甲/方案.md");
    assert_eq!(document["readerPath"], path);
    assert_eq!(document["readerUrl"], format!("{base}{path}"));
    let retry = server
        .tool(&who, "workspace_upload_files", upload.clone())
        .await;
    assert_eq!(retry["structuredContent"], *receipt);
    let read = server
        .tool(&who, "document_read", json!({"documentId":id}))
        .await;
    assert_eq!(
        read["structuredContent"]["markdown"],
        "原文\r\n![图](img.png)\r\n"
    );
    assert_eq!(
        fs::read(server.root.path().join("spaces/left/项目甲/img.png")).unwrap(),
        IMAGE
    );
    let mut injected = upload;
    injected["readerUrl"] = json!("https://untrusted.example");
    assert_eq!(
        server.tool(&who, "workspace_upload_files", injected).await["isError"],
        true
    );
    let bob = server.connect("bob", "right").await;
    assert_eq!(
        server
            .tool(&bob, "document_read", json!({"documentId":id}))
            .await["isError"],
        true
    );
}

#[tokio::test]
async fn mcp_batch_write_reuses_receipt_and_other_grant_cannot_get_or_undo_operation() {
    let server = Server::boot().await;
    let alice = server.connect("alice", "left").await;
    let other = server.connect("alice", "left").await;
    let reader = server.connect("reader", "left").await;
    let ws = workspace(&server, &alice).await;
    let request = json!({"workspaceId":ws,"operationId":OP,"edits":[
        {"path":"Report.md","baseRevision":null,"markdown":"Report\r\n"},
        {"path":"Notes.md","baseRevision":null,"markdown":"Notes\n"}]});
    let args = json!({"workspaceId":ws,"operationId":OP});
    assert_eq!(
        server
            .tool(&reader, "workspace_apply_edits", request.clone())
            .await["isError"],
        true
    );
    let write = server
        .tool(&alice, "workspace_apply_edits", request.clone())
        .await;
    assert_ne!(write["isError"], true, "{write}");
    assert_eq!(write["structuredContent"]["status"], "succeeded");
    assert_eq!(
        server
            .tool(&alice, "workspace_apply_edits", request.clone())
            .await["structuredContent"],
        write["structuredContent"]
    );
    let mut changed = request;
    changed["edits"][0]["markdown"] = json!("changed");
    assert_eq!(
        server.tool(&alice, "workspace_apply_edits", changed).await["isError"],
        true
    );
    for name in ["workspace_get_operation", "workspace_undo_operation"] {
        assert_eq!(
            server.tool(&other, name, args.clone()).await["isError"],
            true
        );
    }
    assert_eq!(
        server
            .tool(&alice, "workspace_get_operation", args.clone())
            .await["structuredContent"],
        write["structuredContent"]
    );
    assert_ne!(
        server.tool(&alice, "workspace_undo_operation", args).await["isError"],
        true
    );
    assert!(!server.root.path().join("spaces/left/Report.md").exists());
    assert!(!server.root.path().join("spaces/left/Notes.md").exists());
}

#[tokio::test]
async fn mcp_reorganization_requires_live_original_grant() {
    let server = Server::boot().await;
    let who = server.connect("alice", "left").await;
    let ws = workspace(&server, &who).await;
    let list = server
        .tool(&who, "document_list", json!({"workspaceId":ws}))
        .await;
    let doc = list["structuredContent"]["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["path"] == "Same.md")
        .unwrap();
    let request = json!({"workspaceId":ws,"operationId":OP,"request":{"kind":"delete","documentIds":[doc["id"]]}});
    let preview = server
        .tool(&who, "workspace_request_reorganization", request)
        .await;
    assert_ne!(preview["isError"], true, "{preview}");
    let receipt = &preview["structuredContent"];
    assert_eq!(receipt["status"], "needs_confirmation");
    assert!(
        receipt["readerPath"].as_str().unwrap().contains(OP),
        "{preview}"
    );
    server
        .client
        .post(format!("{}/.auth/revoke", server.url))
        .form(&[("token", &who.refresh), ("client_id", &who.client)])
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let confirm = server
        .client
        .post(format!("{}/api/v1/ai/operations/{OP}/confirm", server.url))
        .header(header::COOKIE, &who.cookie)
        .header(header::ORIGIN, &server.url)
        .json(&json!({"confirmationId":receipt["confirmation"]["id"]}))
        .send()
        .await
        .unwrap();
    assert!(confirm.status().is_client_error());
    assert_eq!(
        fs::read(server.root.path().join("spaces/left/Same.md")).unwrap(),
        LEFT.as_bytes()
    );
}
