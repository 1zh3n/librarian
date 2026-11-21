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
