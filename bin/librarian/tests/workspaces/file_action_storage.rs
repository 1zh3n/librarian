use super::*;

impl Fixture {
    async fn file_action(&self, workspace: &str, input: &Value, operation: &str) -> Value {
        let route = format!("/workspaces/{workspace}/file-actions");
        let (status, preview) = self
            .request(
                &self.admin,
                "POST",
                &format!("{route}/preview"),
                input.clone(),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{preview}");
        let mut input = input.clone();
        input["operationId"] = json!(operation);
        input["token"] = preview["token"].clone();
        let path = format!("{route}/apply");
        let (status, receipt) = self
            .request(&self.admin, "POST", &path, input.clone())
            .await;
        assert_eq!(status, StatusCode::OK, "{receipt}");
        let (status, replay) = self.request(&self.admin, "POST", &path, input).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay, receipt);
        receipt
    }
}

#[tokio::test]
async fn file_action_cross_workspace_keeps_folder_bytes_id_and_snapshot_scope() {
    let mut f = Fixture::open();
    let source = f.legacy().await;
    let src = source["id"].as_str().unwrap();
    let (_, target) = f
        .request(
            &f.admin,
            "POST",
            "/workspaces",
            json!({"name":"仅目标空间"}),
        )
        .await;
    let dst = target["id"].as_str().unwrap();
    let id = f.document(&f.bob, src, "field/Note.md").await["id"].clone();
    fs::create_dir_all(f.folder(&source).join("field/media/empty")).unwrap();
    let (status, conversation) = f
        .request(
            &f.admin,
            "POST",
            "/ai/conversations",
            json!({"workspaceId":src,"documentId":id}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{conversation}");
    let turns = format!(
        "/ai/conversations/{}/turns",
        conversation["id"].as_str().unwrap()
    );
    let mut snapshots = Vec::new();
    for kind in ["current", "release"] {
        let (status, snap) = f
            .request(
                &f.admin,
                "POST",
                &format!("/workspaces/{src}/snapshots"),
                json!({"kind":kind,"audience":"share","documentIds":[id]}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{snap}");
        snapshots.push(format!("/snapshots/{}", snap["id"].as_str().unwrap()));
    }
    let req = json!({"action":"move", "sourceKind":"folder", "sourcePath":"field","targetPath":"archive", "targetWorkspace":dst});
    f.file_action(src, &req, "1d298202-f9a1-4dd4-8171-c89b74bade85")
        .await;
    f.restart();
    assert!(!f.folder(&source).join("field").exists());
    assert_eq!(f.document(&f.admin, dst, "archive/Note.md").await["id"], id);
    let archive = f.folder(&target).join("archive");
    assert_eq!(fs::read(archive.join("Note.md")).unwrap(), NOTE.as_bytes());
    assert_eq!(
        fs::read(archive.join("Note.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(fs::read(archive.join("media/bird.png")).unwrap(), PHOTO);
    assert!(archive.join("media/empty").is_dir());
    let (status, old_turn) = f
        .request(
            &f.admin,
            "POST",
            &turns,
            json!({"clientTurnId":"after-transfer","mode":"chat","prompt":"Read the target"}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{old_turn}");
    let doc = format!("/documents/{}", id.as_str().unwrap());
    assert_eq!(
        f.request(&f.bob, "GET", &doc, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(&f.admin, "GET", &doc, Value::Null).await.1["document"]["workspaceId"],
        dst
    );
    assert_eq!(
        f.request(&f.bob, "GET", &snapshots[0], Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(&f.bob, "GET", &snapshots[1], Value::Null).await.1["document"]["markdown"],
        NOTE
    );
}

#[tokio::test]
async fn moving_one_document_copies_its_local_image_without_rewriting_markdown() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    let created = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/PhotoNote.md",
                "markdown": "![bird](media/bird.png)\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    let id = created.1["document"]["id"].as_str().unwrap();
    let shared = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/OtherPhoto.md",
                "markdown": "![bird](media/bird.png)\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(shared.0, StatusCode::CREATED, "{}", shared.1);
    fs::create_dir(f.folder(&source).join("archive")).unwrap();
    f.file_action(
        ws,
        &json!({
            "action": "move",
            "sourceKind": "document",
            "sourcePath": "field/PhotoNote.md",
            "expectedDocumentId": id,
            "targetPath": "archive/PhotoNote.md",
            "targetWorkspace": ws,
        }),
        "6a5c1f6a-9e66-4f0e-9c40-6a74e2c5a3d1",
    )
    .await;
    let root = f.folder(&source);
    assert_eq!(
        fs::read(root.join("archive/PhotoNote.md")).unwrap(),
        b"![bird](media/bird.png)\n"
    );
    assert_eq!(
        fs::read(root.join("archive/media/bird.png")).unwrap(),
        PHOTO
    );
    assert_eq!(fs::read(root.join("field/media/bird.png")).unwrap(), PHOTO);
    assert!(!root.join("field/PhotoNote.md").exists());
}

#[tokio::test]
async fn moving_a_document_rejects_missing_or_html_image_references() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    for (path, markdown) in [
        ("field/Missing.md", "![missing](media/missing.png)\n"),
        ("field/Html.md", "<img src=\"media/bird.png\">\n"),
        ("field/Nul.md", "![bad](media/%00.png)\n"),
        ("field/Hidden.md", "![hidden](.hidden/bird.png)\n"),
    ] {
        let created = f
            .request(
                &f.admin,
                "POST",
                &format!("/workspaces/{ws}/documents"),
                json!({"path": path, "markdown": markdown, "baseRevision": null}),
            )
            .await;
        assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    }
    for path in [
        "field/Missing.md",
        "field/Html.md",
        "field/Nul.md",
        "field/Hidden.md",
    ] {
        let (status, error) = f
            .request(
                &f.admin,
                "POST",
                &format!("/workspaces/{ws}/file-actions/preview"),
                json!({
                    "action": "move",
                    "sourceKind": "document",
                    "sourcePath": path,
                    "targetPath": "archive/moved.md",
                    "targetWorkspace": ws,
                }),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
        assert_eq!(error["code"], "unsupported_image_reference", "{error}");
    }
}

#[tokio::test]
async fn moving_a_document_deduplicates_references_and_blocks_target_image_collisions() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    let created = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/sub/PhotoNote.md",
                "markdown": "![bird](../media/bird.png)\\n![again](../media/bird.png)\\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    let id = created.1["document"]["id"].as_str().unwrap();
    fs::create_dir(f.folder(&source).join("archive")).unwrap();
    f.file_action(
        ws,
        &json!({
            "action": "move",
            "sourceKind": "document",
            "sourcePath": "field/sub/PhotoNote.md",
            "expectedDocumentId": id,
            "targetPath": "archive/PhotoNote.md",
            "targetWorkspace": ws,
        }),
        "ec0f4bd3-5a86-4dc8-91d6-05ba7f5a73d8",
    )
    .await;
    assert_eq!(
        fs::read(f.folder(&source).join("media/bird.png")).unwrap(),
        PHOTO
    );
    assert!(!f.folder(&source).join("archive/media/bird.png").exists());

    let blocked = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/Blocked.md",
                "markdown": "![bird](media/bird.png)\\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(blocked.0, StatusCode::CREATED, "{}", blocked.1);
    let blocked_id = blocked.1["document"]["id"].as_str().unwrap();
    fs::create_dir_all(f.folder(&source).join("taken/media")).unwrap();
    fs::write(f.folder(&source).join("taken/media/bird.png"), b"different").unwrap();
    let (status, error) = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/file-actions/preview"),
            json!({
                "action": "move",
                "sourceKind": "document",
                "sourcePath": "field/Blocked.md",
                "expectedDocumentId": blocked_id,
                "targetPath": "taken/Blocked.md",
                "targetWorkspace": ws,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "path_exists", "{error}");
}

#[tokio::test]
async fn copying_one_document_copies_its_local_image_and_keeps_the_source() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    let created = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/CopyNote.md",
                "markdown": "![bird](media/bird.png)\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    let id = created.1["document"]["id"].as_str().unwrap();
    fs::create_dir(f.folder(&source).join("archive")).unwrap();
    f.file_action(
        ws,
        &json!({
            "action": "copy",
            "sourceKind": "document",
            "sourcePath": "field/CopyNote.md",
            "expectedDocumentId": id,
            "targetPath": "archive/CopyNote.md",
            "targetWorkspace": ws,
        }),
        "0f6c2a4e-7b3f-4aa1-bf8c-5c5f1e5c0a11",
    )
    .await;
    let root = f.folder(&source);
    assert_eq!(
        fs::read(root.join("archive/CopyNote.md")).unwrap(),
        b"![bird](media/bird.png)\n"
    );
    assert_eq!(
        fs::read(root.join("archive/media/bird.png")).unwrap(),
        PHOTO
    );
    assert_eq!(
        fs::read(root.join("field/CopyNote.md")).unwrap(),
        b"![bird](media/bird.png)\n"
    );
    assert_eq!(fs::read(root.join("field/media/bird.png")).unwrap(), PHOTO);
}

#[tokio::test]
async fn deleting_one_document_keeps_its_local_image() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    let created = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/DeleteNote.md",
                "markdown": "![bird](media/bird.png)\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    let id = created.1["document"]["id"].as_str().unwrap();
    f.file_action(
        ws,
        &json!({
            "action": "delete",
            "sourceKind": "document",
            "sourcePath": "field/DeleteNote.md",
            "expectedDocumentId": id,
        }),
        "6f3d1b5a-8c4e-4bb2-ae9d-6d6a2f6d1b22",
    )
    .await;
    let root = f.folder(&source);
    assert!(!root.join("field/DeleteNote.md").exists());
    assert_eq!(fs::read(root.join("field/media/bird.png")).unwrap(), PHOTO);
}

#[tokio::test]
async fn moving_a_document_limits_referenced_image_count_and_total_bytes() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    let root = f.folder(&source);
    let media = root.join("field/media");
    let mut markdown = String::new();
    for number in 1..=65 {
        let name = format!("count-{number}.png");
        fs::write(media.join(&name), PHOTO).unwrap();
        markdown.push_str(&format!("![{number}](media/{name})\n"));
    }
    let too_many = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/Count.md",
                "markdown": markdown,
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(too_many.0, StatusCode::CREATED, "{}", too_many.1);
    let too_many_id = too_many.1["document"]["id"].as_str().unwrap();
    let (status, error) = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/file-actions/preview"),
            json!({
                "action": "move",
                "sourceKind": "document",
                "sourcePath": "field/Count.md",
                "expectedDocumentId": too_many_id,
                "targetPath": "archive/Count.md",
                "targetWorkspace": ws,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    assert_eq!(error["code"], "too_many_referenced_assets", "{error}");

    fs::write(media.join("large-1.png"), vec![0u8; 12 * 1024 * 1024]).unwrap();
    fs::write(media.join("large-2.png"), vec![0u8; 12 * 1024 * 1024]).unwrap();
    let too_large = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({
                "path": "field/TooLarge.md",
                "markdown": "![one](media/large-1.png)\n![two](media/large-2.png)\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(too_large.0, StatusCode::CREATED, "{}", too_large.1);
    let too_large_id = too_large.1["document"]["id"].as_str().unwrap();
    let (status, error) = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/file-actions/preview"),
            json!({
                "action": "move",
                "sourceKind": "document",
                "sourcePath": "field/TooLarge.md",
                "expectedDocumentId": too_large_id,
                "targetPath": "archive/TooLarge.md",
                "targetWorkspace": ws,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{error}");
    assert_eq!(error["code"], "asset_batch_too_large", "{error}");
}

#[tokio::test]
async fn moving_one_document_to_another_workspace_copies_its_local_image() {
    let f = Fixture::open();
    let source = f.legacy().await;
    let src = source["id"].as_str().unwrap();
    let (_, target) = f
        .request(
            &f.admin,
            "POST",
            "/workspaces",
            json!({"name":"图片目标空间"}),
        )
        .await;
    let dst = target["id"].as_str().unwrap();
    let created = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{src}/documents"),
            json!({
                "path": "field/PhotoNote.md",
                "markdown": "![bird](media/bird.png)\n",
                "baseRevision": null,
            }),
        )
        .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    let id = created.1["document"]["id"].as_str().unwrap();
    fs::create_dir(f.folder(&target).join("archive")).unwrap();
    f.file_action(
        src,
        &json!({
            "action": "move",
            "sourceKind": "document",
            "sourcePath": "field/PhotoNote.md",
            "expectedDocumentId": id,
            "targetPath": "archive/PhotoNote.md",
            "targetWorkspace": dst,
        }),
        "15ebcc21-6b18-4ee9-a747-87ce29f7e9dc",
    )
    .await;
    assert_eq!(
        fs::read(f.folder(&target).join("archive/media/bird.png")).unwrap(),
        PHOTO
    );
    assert_eq!(
        fs::read(f.folder(&source).join("field/media/bird.png")).unwrap(),
        PHOTO
    );
}

#[tokio::test]
async fn file_action_copy_delete_undo_retain_separate_identities_and_new_occupant() {
    let mut f = Fixture::open();
    let source = f.legacy().await;
    let ws = source["id"].as_str().unwrap();
    let id = f.document(&f.admin, ws, "field/Note.md").await["id"].clone();
    let copy = f
        .file_action(
            ws,
            &json!({"action":"copy","sourceKind":"document","sourcePath":"field/Note.md",
        "expectedDocumentId":id, "targetPath":"Elsewhere.md", "targetWorkspace":ws}),
            "ea584b57-a2c1-4ad1-99a8-faeb6d08a8a2",
        )
        .await;
    assert_ne!(copy["documentId"], id);
    assert_eq!(
        copy["documentId"],
        f.document(&f.admin, ws, "Elsewhere.md").await["id"]
    );
    assert_eq!(
        fs::read(f.folder(&source).join("Elsewhere.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    let operation = "39c8c204-39d8-4b06-8401-39a20288ad32";
    fs::create_dir_all(f.folder(&source).join("field/empty")).unwrap();
    let deleted = f
        .file_action(
            ws,
            &json!({"action":"delete","sourceKind":"folder","sourcePath":"field"}),
            operation,
        )
        .await;
    assert_eq!(deleted["undoable"], true);
    let deletion_parent = || {
        let output = Command::new("git")
            .arg("-C")
            .arg(f.folder(&source))
            .args(["log", "-1", "--format=%H", "HEAD^", "--", "field/Note.md"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    let original_commit = deletion_parent();
    assert!(!f.folder(&source).join("field").exists());
    let undo = format!("/workspaces/{ws}/file-actions/undo");
    f.restart();
    fs::create_dir(f.folder(&source).join("field")).unwrap();
    fs::write(f.folder(&source).join("field/Note.md"), "new occupant").unwrap();
    let replacement = f.document(&f.admin, ws, "field/Note.md").await["id"].clone();
    assert_ne!(replacement, id);
    assert_eq!(
        f.request(&f.admin, "POST", &undo, json!({"operationId":operation}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fs::read_to_string(f.folder(&source).join("field/Note.md")).unwrap(),
        "new occupant"
    );
    f.file_action(
        ws,
        &json!({"action":"delete","sourceKind":"folder","sourcePath":"field"}),
        "746f8e37-d699-48e1-ada4-a602aaa7a905",
    )
    .await;
    let output = Command::new("git")
        .arg("-C")
        .arg(f.folder(&source))
        .args(["log", "-1", "--format=%H", "HEAD^", "--", "field/Note.md"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let replacement_commit = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    for _ in 0..2 {
        let (status, result) = f
            .request(&f.admin, "POST", &undo, json!({"operationId":operation}))
            .await;
        assert_eq!(status, StatusCode::OK, "{result}");
    }
    assert_eq!(f.document(&f.admin, ws, "field/Note.md").await["id"], id);
    let history_path = format!("/documents/{}/revisions", id.as_str().unwrap());
    let (_, history) = f.request(&f.admin, "GET", &history_path, Value::Null).await;
    let commits = history["revisions"].as_array().unwrap();
    assert!(
        commits.iter().any(|c| c["commitId"] == original_commit),
        "{history}"
    );
    assert!(
        commits.iter().all(|c| c["commitId"] != replacement_commit),
        "{history}"
    );
    let first = commits[0]["commitId"].as_str().unwrap();
    let (_, page) = f
        .request(
            &f.admin,
            "GET",
            &format!("{history_path}?limit=1&before={first}"),
            Value::Null,
        )
        .await;
    assert_eq!(page["revisions"][0]["commitId"], original_commit, "{page}");
    let (status,release)=f.request(&f.admin,"POST",&format!("/workspaces/{ws}/snapshots"),
        json!({"kind":"release","audience":"members","documentIds":[id],"commitId":original_commit})).await;
    assert_eq!(status, StatusCode::CREATED, "{release}");
    let (status, pinned) = f
        .request(
            &f.bob,
            "GET",
            &format!("/snapshots/{}", release["id"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pinned}");
    assert_eq!(pinned["document"]["markdown"], NOTE);
    let (status, diff) = f
        .request(
            &f.admin,
            "GET",
            &format!("{history_path}/{original_commit}/diff"),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{diff}");
    assert_eq!(diff["markdown"], NOTE);
    assert_eq!(
        f.request(
            &f.admin,
            "GET",
            &format!("{history_path}/{replacement_commit}/diff"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fs::read(f.folder(&source).join("field/Note.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(
        fs::read(f.folder(&source).join("field/media/bird.png")).unwrap(),
        PHOTO
    );
    assert!(f.folder(&source).join("field/empty").is_dir());
}

#[tokio::test]
async fn file_action_recovers_interrupted_identity_commit_and_replays_exact_result() {
    let mut f = Fixture::open();
    let source = f.legacy().await;
    let src = source["id"].as_str().unwrap();
    let (_, target) = f
        .request(&f.admin, "POST", "/workspaces", json!({"name":"Recovery"}))
        .await;
    let dst = target["id"].as_str().unwrap();
    let id = f.document(&f.admin, src, "field/Note.md").await["id"].clone();
    let req = json!({"action":"move","sourceKind":"document","sourcePath":"field/Note.md","expectedDocumentId":id,
        "targetWorkspace":dst,"targetPath":"Moved.md"});
    let route = format!("/workspaces/{src}/file-actions");
    let (status, preview) = f
        .request(&f.admin, "POST", &format!("{route}/preview"), req.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let mut apply = req;
    apply["token"] = preview["token"].clone();
    apply["operationId"] = json!("b519bba7-8cbc-4b60-8973-e650c69ab5fd");
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER interrupted BEFORE UPDATE OF workspace_id ON documents
                      BEGIN SELECT RAISE(FAIL,'interrupted before mapping'); END;",
    )
    .unwrap();
    assert_eq!(
        f.request(&f.admin, "POST", &format!("{route}/apply"), apply.clone())
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    db.execute_batch("DROP TRIGGER interrupted").unwrap();
    drop(db);
    f.restart();
    assert_eq!(f.document(&f.admin, dst, "Moved.md").await["id"], id);
    let (status, replayed) = f
        .request(&f.admin, "POST", &format!("{route}/apply"), apply)
        .await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["documentId"], id);
    assert!(!f.folder(&source).join("field/Note.md").exists());
}

#[tokio::test]
async fn file_action_recovery_checks_both_workspaces_before_removing_source() {
    for outside_edit in [None, Some("source"), Some("target")] {
        let mut f = Fixture::open();
        let source = f.legacy().await;
        let src = source["id"].as_str().unwrap();
        let (_, target) = f
            .request(
                &f.admin,
                "POST",
                "/workspaces",
                json!({"name":"Destination"}),
            )
            .await;
        let dst = target["id"].as_str().unwrap();
        let id = f.document(&f.admin, src, "field/Note.md").await["id"].clone();
        let mut req = json!({"action":"move","sourceKind":"document","sourcePath":"field/Note.md","expectedDocumentId":id,
            "targetWorkspace":dst,"targetPath":"Saved.md"});
        let route = format!("/workspaces/{src}/file-actions");
        let (status, p) = f
            .request(&f.admin, "POST", &format!("{route}/preview"), req.clone())
            .await;
        assert_eq!(status, StatusCode::OK, "{p}");
        req["token"] = p["token"].clone();
        req["operationId"] = json!("a3186e36-93eb-47f9-b94f-890f22f78b36");
        let db =
            rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER stop_source BEFORE INSERT ON mutations
            WHEN (SELECT space_id FROM workspaces WHERE id=NEW.workspace_id)='legacy'
            BEGIN SELECT RAISE(FAIL,'interrupt before removing source'); END;",
        )
        .unwrap();
        let (status, body) = f
            .request(&f.admin, "POST", &format!("{route}/apply"), req.clone())
            .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        db.execute_batch("DROP TRIGGER stop_source").unwrap();
        drop(db);
        let original = f.folder(&source).join("field/Note.md");
        let destination = f.folder(&target).join("Saved.md");
        assert_eq!(fs::read(&original).unwrap(), NOTE.as_bytes());
        assert_eq!(fs::read(&destination).unwrap(), NOTE.as_bytes());
        match outside_edit {
            Some("source") => fs::write(&original, "concurrent source edit").unwrap(),
            Some("target") => fs::write(&destination, "concurrent destination edit").unwrap(),
            _ => {}
        }
        f.restart();
        let (status, body) = f
            .request(&f.admin, "POST", &format!("{route}/apply"), req)
            .await;
        if outside_edit.is_some() {
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(f.document(&f.admin, src, "field/Note.md").await["id"], id);
            assert_ne!(f.document(&f.admin, dst, "Saved.md").await["id"], id);
            if outside_edit == Some("source") {
                assert_eq!(
                    fs::read_to_string(&original).unwrap(),
                    "concurrent source edit"
                );
            } else {
                assert_eq!(
                    fs::read_to_string(&destination).unwrap(),
                    "concurrent destination edit"
                );
            }
        } else {
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(!original.exists());
            assert_eq!(f.document(&f.admin, dst, "Saved.md").await["id"], id);
        }
    }
}

#[tokio::test]
async fn file_action_restart_leaves_an_unpublished_copy_for_authorized_retry() {
    let mut f = Fixture::open();
    let source = f.legacy().await;
    let src = source["id"].as_str().unwrap();
    let (_, target) = f
        .request(
            &f.admin,
            "POST",
            "/workspaces",
            json!({"name":"Destination"}),
        )
        .await;
    let dst = target["id"].as_str().unwrap();
    let mut req = json!({"action":"copy","sourceKind":"document","sourcePath":"Legacy.md","targetWorkspace":dst,"targetPath":"Saved.md"});
    let route = format!("/workspaces/{src}/file-actions");
    let (status, p) = f
        .request(&f.admin, "POST", &format!("{route}/preview"), req.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{p}");
    req["token"] = p["token"].clone();
    req["operationId"] = json!("e4edff11-9708-464e-9c70-c90567b9e258");
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_copy BEFORE INSERT ON mutations BEGIN SELECT RAISE(FAIL,'interrupt before first write'); END;").unwrap();
    assert_eq!(
        f.request(&f.admin, "POST", &format!("{route}/apply"), req.clone())
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    db.execute_batch("DROP TRIGGER stop_copy").unwrap();
    drop(db);
    f.restart();
    assert!(!f.folder(&target).join("Saved.md").exists());
    let (status, receipt) = f
        .request(&f.admin, "POST", &format!("{route}/apply"), req)
        .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(
        fs::read(f.folder(&source).join("Legacy.md")).unwrap(),
        fs::read(f.folder(&target).join("Saved.md")).unwrap()
    );
}

#[tokio::test]
async fn file_action_recovery_preserves_replacement_before_identity_commit() {
    for (action, cross, occupied) in [
        ("move", false, false),
        ("move", true, false),
        ("move", true, true),
        ("copy", false, false),
        ("undo", false, false),
    ] {
        let mut f = Fixture::open();
        let source = f.legacy().await;
        let ws = source["id"].as_str().unwrap();
        let id = f.document(&f.admin, ws, "field/Note.md").await["id"].clone();
        let target = if cross {
            f.request(
                &f.admin,
                "POST",
                "/workspaces",
                json!({"name":"Other workspace"}),
            )
            .await
            .1
        } else {
            source.clone()
        };
        let target_ws = target["id"].as_str().unwrap();
        let target_root = f.folder(&target);
        let root = f.folder(&source);
        let route = format!("/workspaces/{ws}/file-actions");
        let mut req = json!({"action":action,"sourcePath":"field/Note.md","sourceKind":"document","expectedDocumentId":id,
            "targetWorkspace":target_ws,"targetPath":"Saved.md"});
        let path = if action == "undo" {
            let deletion = json!({"action":"delete","sourcePath":"field/Note.md","sourceKind":"document","expectedDocumentId":id});
            f.file_action(ws, &deletion, "d143f99f-f47d-467b-b0bb-baba6eed3c57")
                .await;
            req = json!({"operationId":"d143f99f-f47d-467b-b0bb-baba6eed3c57"});
            format!("{route}/undo")
        } else {
            let (status, p) = f
                .request(&f.admin, "POST", &format!("{route}/preview"), req.clone())
                .await;
            assert_eq!(status, StatusCode::OK, "{p}");
            req["operationId"] = json!("c7da5e01-9aae-45bc-8d98-0b79e9f4c7fd");
            req["token"] = p["token"].clone();
            format!("{route}/apply")
        };
        let db =
            rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER interrupt_mapping BEFORE UPDATE OF status ON workspace_file_actions
            WHEN NEW.status IN ('done','undone') BEGIN SELECT RAISE(FAIL,'interrupt identity commit'); END;").unwrap();
        let (status, body) = f.request(&f.admin, "POST", &path, req.clone()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        db.execute_batch("DROP TRIGGER interrupt_mapping").unwrap();
        drop(db);
        let dst = if action == "undo" {
            "field/Note.md"
        } else {
            "Saved.md"
        };
        let before = target_root.join("before-replacement");
        fs::rename(target_root.join(dst), &before).unwrap();
        // Same bytes plus a different inode exercise the identical replacement case.
        fs::write(target_root.join(dst), NOTE.as_bytes()).unwrap();
        if occupied {
            fs::write(root.join("field/Note.md"), "source replacement").unwrap();
        }
        f.restart();
        assert_ne!(
            f.document(&f.admin, target_ws, dst).await["id"],
            id,
            "{action}"
        );
        assert_eq!(fs::read(target_root.join(dst)).unwrap(), NOTE.as_bytes());
        let (status, body) = f.request(&f.admin, "POST", &path, req).await;
        assert_eq!(status, StatusCode::CONFLICT, "{action}: {body}");
        if occupied {
            assert_ne!(f.document(&f.admin, ws, "field/Note.md").await["id"], id);
            assert_eq!(
                fs::read_to_string(root.join("field/Note.md")).unwrap(),
                "source replacement"
            );
        } else if action != "undo" {
            assert_eq!(f.document(&f.admin, ws, "field/Note.md").await["id"], id);
            assert_eq!(
                fs::read(root.join("field/Note.md")).unwrap(),
                NOTE.as_bytes()
            );
        }
    }
}

#[tokio::test]
async fn file_action_transfers_renames_deletes_and_restores_an_empty_tree() {
    let mut f = Fixture::open();
    let source = f.legacy().await;
    let src = source["id"].as_str().unwrap();
    let (_, target) = f
        .request(
            &f.admin,
            "POST",
            "/workspaces",
            json!({"name":"Empty destination"}),
        )
        .await;
    let dst = target["id"].as_str().unwrap();
    fs::create_dir_all(f.folder(&source).join("empty/nested")).unwrap();
    let req = json!({"action":"copy","sourcePath":"empty","sourceKind":"folder","targetWorkspace":dst,"targetPath":"copy"});
    f.file_action(src, &req, "ad742785-f8a8-4e02-bcab-7093668eee25")
        .await;
    assert!(f.folder(&source).join("empty/nested").is_dir());
    assert!(f.folder(&target).join("copy/nested").is_dir());
    let mut req = req;
    req["action"] = json!("move");
    req["targetPath"] = json!("moved");
    f.file_action(src, &req, "19b8b972-7201-4468-b2a2-f3ab458ef59d")
        .await;
    assert!(!f.folder(&source).join("empty").exists());
    req["sourcePath"] = json!("moved");
    req["targetPath"] = json!("renamed");
    f.file_action(dst, &req, "ce13c1b5-96db-49a5-a474-3718b3a34a4a")
        .await;
    let op = "c206faf5-4aa6-480a-920a-f9f8975cb5e8";
    f.file_action(
        dst,
        &json!({"action":"delete","sourcePath":"renamed","sourceKind":"folder"}),
        op,
    )
    .await;
    assert!(!f.folder(&target).join("renamed").exists());
    f.restart();
    let (status, body) = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{dst}/file-actions/undo"),
            json!({"operationId":op}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(f.folder(&target).join("renamed/nested").is_dir());
    assert!(f.folder(&target).join("copy/nested").is_dir());
}

#[tokio::test]
async fn recently_deleted_lists_only_own_restorable_items_newest_first() {
    let mut f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let route = format!("/workspaces/{ws}/file-actions");
    let first = "ebe68b37-b11f-4149-b117-a4b393277cde";
    let second = "13b5b285-8ddd-4806-9d34-e3a268371cf0";
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"field","sourceKind":"folder"}),
        first,
    )
    .await;
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"Legacy.md","sourceKind":"document"}),
        second,
    )
    .await;
    f.restart();
    let endpoint = format!("{route}/deleted");
    let (status, list) = f.request(&f.admin, "GET", &endpoint, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list,
        json!({"items":[
            {"operationId":second,"path":"Legacy.md","sourceKind":"document","fileCount":1},
            {"operationId":first,"path":"field","sourceKind":"folder","fileCount":3}
        ]})
    );
    assert_eq!(
        f.request(&f.alice, "GET", &endpoint, Value::Null).await.1,
        json!({"items":[]})
    );
    assert_eq!(
        f.request(&f.bob, "GET", &endpoint, Value::Null).await.0,
        StatusCode::FORBIDDEN
    );
    let (_, other) = f
        .request(&f.admin, "POST", "/workspaces", json!({"name":"Other"}))
        .await;
    assert_eq!(
        f.request(
            &f.admin,
            "GET",
            &format!(
                "/workspaces/{}/file-actions/deleted",
                other["id"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .1,
        json!({"items":[]})
    );
    assert_eq!(
        f.request(
            &f.alice,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":second,"targetPath":"Leaked.md"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, result) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":second}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (_, remaining) = f.request(&f.admin, "GET", &endpoint, Value::Null).await;
    assert_eq!(remaining["items"], json!([list["items"][1]]));
}

#[tokio::test]
async fn recently_deleted_restores_a_tree_elsewhere_and_resumes_after_interruption() {
    let mut f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let root = f.folder(&w);
    let id = f.document(&f.admin, ws, "field/Note.md").await["id"].clone();
    fs::create_dir_all(root.join("field/empty")).unwrap();
    let op = "05d99b8b-ed6c-4311-9fd8-995c994df8f0";
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"field","sourceKind":"folder"}),
        op,
    )
    .await;
    let output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["log", "-1", "--format=%H", "HEAD^", "--", "field/Note.md"])
        .output()
        .unwrap();
    let old_commit = String::from_utf8(output.stdout).unwrap().trim().to_string();
    let (status, replacement) = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({"path":"field/Note.md","markdown":"replacement","baseRevision":null}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{replacement}");
    let other = replacement["documentId"].clone();
    let route = format!("/workspaces/{ws}/file-actions/undo");
    for (value, status) in [
        (json!({"operationId":op}), StatusCode::CONFLICT),
        (
            json!({"operationId":op,"targetPath":"../bad"}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        assert_eq!(f.request(&f.admin, "POST", &route, value).await.0, status);
    }
    fs::create_dir(root.join("recovered")).unwrap();
    let input = json!({"operationId":op,"targetPath":"recovered/original"});
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER interrupt_mapped_restore BEFORE UPDATE OF status ON workspace_file_actions
        WHEN NEW.status='undone' BEGIN SELECT RAISE(FAIL,'stop before identity commit'); END;",
    )
    .unwrap();
    let (status, body) = f.request(&f.admin, "POST", &route, input.clone()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    db.execute_batch("DROP TRIGGER interrupt_mapped_restore")
        .unwrap();
    drop(db);
    f.restart();
    let (status, receipt) = f.request(&f.admin, "POST", &route, input).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["path"], "recovered/original");
    assert_eq!(
        f.document(&f.admin, ws, "recovered/original/Note.md").await["id"],
        id
    );
    assert_eq!(f.document(&f.admin, ws, "field/Note.md").await["id"], other);
    assert_eq!(
        fs::read(root.join("field/Note.md")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        fs::read(root.join("recovered/original/Note.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(
        fs::read(root.join("recovered/original/media/bird.png")).unwrap(),
        PHOTO
    );
    assert!(root.join("recovered/original/empty").is_dir());
    let (status, diff) = f
        .request(
            &f.admin,
            "GET",
            &format!(
                "/documents/{}/revisions/{old_commit}/diff",
                id.as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{diff}");
    assert_eq!(diff["markdown"], NOTE);
    assert_eq!(
        f.request(
            &f.admin,
            "POST",
            &route,
            json!({"operationId":op,"targetPath":"another"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert!(!root.join("another").exists());
}

#[tokio::test]
async fn recently_deleted_can_restore_a_document_under_a_new_name_with_outline() {
    let f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let id = f.document(&f.admin, ws, "field/Note.md").await["id"].clone();
    let op = "8b03fc60-e24c-4718-bd87-8b60fe41fbf6";
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"field/Note.md","sourceKind":"document"}),
        op,
    )
    .await;
    let route = format!("/workspaces/{ws}/file-actions/undo");
    fs::write(
        f.folder(&w).join("Restored.outline.md"),
        "unrelated outline",
    )
    .unwrap();
    assert_eq!(
        f.request(
            &f.admin,
            "POST",
            &route,
            json!({"operationId":op,"targetPath":"Restored.md"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, body) = f
        .request(
            &f.admin,
            "POST",
            &route,
            json!({"operationId":op,"targetPath":"Different.md"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["documentId"], id);
    assert_eq!(body["path"], "Different.md");
    assert_eq!(
        fs::read(f.folder(&w).join("Different.md")).unwrap(),
        NOTE.as_bytes()
    );
    assert_eq!(
        fs::read(f.folder(&w).join("Different.outline.md")).unwrap(),
        OUTLINE.as_bytes()
    );
    assert_eq!(
        fs::read(f.folder(&w).join("Restored.outline.md")).unwrap(),
        b"unrelated outline"
    );
}

#[tokio::test]
async fn recently_deleted_unpublished_restore_can_be_retried_without_restart() {
    let f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let route = format!("/workspaces/{ws}/file-actions");
    let op = "14bf487a-bd6f-41d7-8c87-04222c77c7c1";
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"Legacy.md","sourceKind":"document"}),
        op,
    )
    .await;
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON mutations BEGIN SELECT RAISE(FAIL,'cannot begin transaction'); END;").unwrap();
    let (status, body) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":op,"targetPath":"First.md"}),
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    db.execute_batch("DROP TRIGGER fail_restore").unwrap();
    let (status, list) = f
        .request(&f.admin, "GET", &format!("{route}/deleted"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["items"][0]["operationId"], op);
    let (status, body) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":op,"targetPath":"Retry.md"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["path"], "Retry.md");
    assert!(!f.folder(&w).join("First.md").exists());
}

#[tokio::test]
async fn recently_deleted_orders_by_completed_deletion_after_a_retry() {
    let f = Fixture::open();
    let ws = f.legacy().await["id"].as_str().unwrap().to_owned();
    let route = format!("/workspaces/{ws}/file-actions");
    let later = "ef8328f3-bcfd-4124-8ed7-6bfc194fcbbf";
    let earlier = "5c26e707-2d4c-41c2-8000-9c79a518c17f";
    let mut intent = json!({"action":"delete","sourcePath":"Legacy.md","sourceKind":"document"});
    let (_, p) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/preview"),
            intent.clone(),
        )
        .await;
    intent["operationId"] = json!(later);
    intent["token"] = p["token"].clone();
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER stop_first BEFORE INSERT ON mutations BEGIN SELECT RAISE(FAIL,'before first write'); END;").unwrap();
    assert_eq!(
        f.request(&f.admin, "POST", &format!("{route}/apply"), intent.clone())
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    db.execute_batch("DROP TRIGGER stop_first").unwrap();
    f.file_action(
        &ws,
        &json!({"action":"delete","sourcePath":"field","sourceKind":"folder"}),
        earlier,
    )
    .await;
    let (status, r) = f
        .request(&f.admin, "POST", &format!("{route}/apply"), intent)
        .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let (_, list) = f
        .request(&f.admin, "GET", &format!("{route}/deleted"), Value::Null)
        .await;
    assert_eq!(list["items"][0]["operationId"], later, "{list}");
}

#[tokio::test]
async fn recently_deleted_can_change_location_after_parent_removed_or_replaced() {
    let f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let op = "c0fdf239-91f5-4090-bac7-ad0d349d00cd";
    let (_, doc) = f
        .request(
            &f.admin,
            "POST",
            &format!("/workspaces/{ws}/documents"),
            json!({"path":"parent/child/Original.md","markdown":NOTE,"baseRevision":null}),
        )
        .await;
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"parent/child/Original.md","sourceKind":"document"}),
        op,
    )
    .await;
    let root = f.folder(&w);
    fs::remove_dir(root.join("parent/child")).unwrap();
    fs::remove_dir(root.join("parent")).unwrap();
    let route = format!("/workspaces/{ws}/file-actions/undo");
    let (status, missing) = f
        .request(&f.admin, "POST", &route, json!({"operationId":op}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{missing}");
    assert_eq!(missing["code"], "restore_location_unavailable");
    fs::write(root.join("parent"), "another file").unwrap();
    let (status, blocked) = f
        .request(&f.admin, "POST", &route, json!({"operationId":op}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{blocked}");
    assert_eq!(blocked["code"], "path_exists");
    let (status, moved) = f
        .request(
            &f.admin,
            "POST",
            &route,
            json!({"operationId":op,"targetPath":"other.md"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["documentId"], doc["documentId"]);
    assert_eq!(fs::read(root.join("parent")).unwrap(), b"another file");
}

#[tokio::test]
async fn recently_deleted_upgrades_older_receipts_and_relocates_an_empty_folder() {
    let mut f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let root = f.folder(&w);
    let op = "0dd23c36-d464-425a-9206-5346bc8991e5";
    fs::create_dir_all(root.join("archive/empty/nested")).unwrap();
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"archive","sourceKind":"folder"}),
        op,
    )
    .await;
    f.app = Router::new();
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("DROP TABLE completed_file_deletions; ALTER TABLE restored_document_history DROP COLUMN restore_path;").unwrap();
    drop(db);
    f.restart();
    let base = format!("/workspaces/{ws}/file-actions");
    let (status, list) = f
        .request(&f.admin, "GET", &format!("{base}/deleted"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list,
        json!({"items":[{"operationId":op,"sourceKind":"folder","path":"archive","fileCount":0}]})
    );
    fs::write(root.join("archive"), "new occupant").unwrap();
    let input = json!({"operationId":op,"targetPath":"recovered"});
    for _ in 0..2 {
        let (status, r) = f
            .request(&f.admin, "POST", &format!("{base}/undo"), input.clone())
            .await;
        assert_eq!(status, StatusCode::OK, "{r}");
        assert_eq!(r["path"], "recovered");
    }
    assert!(root.join("recovered/empty/nested").is_dir());
    assert_eq!(fs::read(root.join("archive")).unwrap(), b"new occupant");
}

#[tokio::test]
async fn recently_deleted_recovery_checks_empty_tree_parent_and_legacy_receipts() {
    for scenario in [
        "missing",
        "replaced",
        "legacy-staged",
        "legacy-published",
        "unchanged",
        "unrecorded",
    ] {
        let mut f = Fixture::open();
        let w = f.legacy().await;
        let ws = w["id"].as_str().unwrap();
        let root = f.folder(&w);
        let op = "589f6faa-7532-465d-8d6c-1ba2265cf91c";
        let route = format!("/workspaces/{ws}/file-actions");
        fs::create_dir_all(root.join("original/empty")).unwrap();
        fs::create_dir(root.join("selected")).unwrap();
        f.file_action(
            ws,
            &json!({"action":"delete","sourcePath":"original","sourceKind":"folder"}),
            op,
        )
        .await;
        let db =
            rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER interrupt_restore BEFORE UPDATE OF status ON workspace_file_actions WHEN NEW.status='undone'
                          BEGIN SELECT RAISE(FAIL,'interrupt before metadata commit'); END;").unwrap();
        let (status, body) = f
            .request(
                &f.admin,
                "POST",
                &format!("{route}/undo"),
                json!({"operationId":op,"targetPath":"selected/result"}),
            )
            .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        f.app = Router::new();
        db.execute_batch("DROP TRIGGER interrupt_restore").unwrap();
        let step: String = db
            .query_row(
                "SELECT json_extract(plan,'$.undo_step') FROM workspace_file_actions WHERE operation_id=?",
                [op],
                |row| row.get(0),
            )
            .unwrap();
        let stage = root.join(format!(".librarian-directory-{step}"));
        if scenario != "legacy-published" {
            // Reconstruct the state before publishing the staged tree.
            fs::rename(root.join("selected/result"), &stage).unwrap();
        }
        match scenario {
            "legacy-staged" | "legacy-published" => {
                db.execute(
                    "UPDATE workspace_file_actions SET plan=json_remove(plan,'$.restore_parent') WHERE operation_id=?",
                    [op],
                )
                .unwrap();
            }
            "missing" | "replaced" => {
                fs::rename(root.join("selected"), root.join("former-parent")).unwrap();
                if scenario == "replaced" {
                    fs::create_dir(root.join("selected")).unwrap();
                    fs::write(root.join("selected/keep.bin"), b"external").unwrap();
                }
            }
            "unrecorded" => {
                db.execute("DELETE FROM empty_directory_steps WHERE id=?", [&step])
                    .unwrap();
            }
            _ => {}
        }
        drop(db);
        f.restart();
        if matches!(scenario, "legacy-published" | "unchanged") {
            assert!(root.join("selected/result/empty").is_dir(), "{scenario}");
            assert!(!stage.exists(), "{scenario}");
            let (status, result) = f
                .request(
                    &f.admin,
                    "POST",
                    &format!("{route}/undo"),
                    json!({"operationId":op,"targetPath":"selected/result"}),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{scenario}: {result}");
            continue;
        }
        assert!(!root.join("selected/result").exists(), "{scenario}");
        assert_eq!(stage.exists(), scenario == "unrecorded", "{scenario}");
        if scenario == "replaced" {
            assert_eq!(
                fs::read(root.join("selected/keep.bin")).unwrap(),
                b"external"
            );
        }
        let (status, list) = f
            .request(&f.admin, "GET", &format!("{route}/deleted"), Value::Null)
            .await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["items"][0]["operationId"], op, "{scenario}");
        let (status, result) = f
            .request(
                &f.admin,
                "POST",
                &format!("{route}/undo"),
                json!({"operationId":op,"targetPath":"available"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{scenario}: {result}");
        assert!(root.join("available/empty").is_dir());
    }
}

#[tokio::test]
async fn recently_deleted_recovery_preserves_a_file_replacing_an_empty_subfolder() {
    let mut f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let root = f.folder(&w);
    let op = "9eb5fe3f-6c64-4036-89ab-6bf6bc95e6c5";
    let route = format!("/workspaces/{ws}/file-actions");
    fs::create_dir(root.join("field/empty")).unwrap();
    let original = f.document(&f.admin, ws, "field/Note.md").await["id"].clone();
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"field","sourceKind":"folder"}),
        op,
    )
    .await;
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER interrupt_restore BEFORE UPDATE OF status ON workspace_file_actions WHEN NEW.status='undone'
                      BEGIN SELECT RAISE(FAIL,'interrupt before metadata commit'); END;").unwrap();
    let (status, r) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":op,"targetPath":"first"}),
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{r}");
    f.app = Router::new();
    fs::remove_dir(root.join("first/empty")).unwrap();
    fs::write(root.join("first/empty"), b"external").unwrap();
    db.execute_batch("DROP TRIGGER interrupt_restore").unwrap();
    drop(db);
    f.restart();
    assert_eq!(fs::read(root.join("first/empty")).unwrap(), b"external");
    let (status, r) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":op,"targetPath":"second"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(
        f.document(&f.admin, ws, "second/Note.md").await["id"],
        original
    );
    assert!(root.join("second/empty").is_dir());
}

#[tokio::test]
async fn recently_deleted_recovery_preserves_matching_external_bytes_before_git_publication() {
    let mut f = Fixture::open();
    let w = f.legacy().await;
    let ws = w["id"].as_str().unwrap();
    let root = f.folder(&w);
    let op = "1a89ed83-f81f-488c-ae14-2b531d9c6c78";
    let route = format!("/workspaces/{ws}/file-actions");
    let original = f.document(&f.admin, ws, "Legacy.md").await["id"].clone();
    let contents = fs::read(root.join("Legacy.md")).unwrap();
    fs::create_dir(root.join("selected")).unwrap();
    f.file_action(
        ws,
        &json!({"action":"delete","sourcePath":"Legacy.md","sourceKind":"document"}),
        op,
    )
    .await;
    let db = rusqlite::Connection::open(f.root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER interrupt_write BEFORE UPDATE OF state ON mutations WHEN NEW.state='committed'
                      BEGIN SELECT RAISE(FAIL,'leave pending write'); END;").unwrap();
    let (status, r) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":op,"targetPath":"selected/result.md"}),
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{r}");
    f.app = Router::new();
    db.execute_batch("DROP TRIGGER interrupt_write").unwrap();
    drop(db);
    // Reconstruct a crash after the file write, before Git publication.
    let reset = Command::new("git")
        .current_dir(&root)
        .args(["reset", "--mixed", "HEAD^"])
        .output()
        .unwrap();
    assert!(reset.status.success(), "{reset:?}");
    fs::rename(root.join("selected"), root.join("previous-parent")).unwrap();
    fs::create_dir(root.join("selected")).unwrap();
    fs::write(root.join("selected/result.md"), &contents).unwrap();
    f.restart();
    assert_eq!(fs::read(root.join("selected/result.md")).unwrap(), contents);
    let (status, r) = f
        .request(
            &f.admin,
            "POST",
            &format!("{route}/undo"),
            json!({"operationId":op,"targetPath":"restored.md"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(
        f.document(&f.admin, ws, "restored.md").await["id"],
        original
    );
    assert_ne!(
        f.document(&f.admin, ws, "selected/result.md").await["id"],
        original
    );
}
