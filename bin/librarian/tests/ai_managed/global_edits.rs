use super::{call, json, Auth, Site, Value, ORIGINAL, OWNER, V2};

#[tokio::test]
async fn global_edits_require_a_full_read_in_the_target_and_undo_only_that_workspace() {
    let site = Site::new().await;
    let member = Auth {
        token: &site.member,
        instance: None,
    };
    let create = call(
        &site.app,
        member,
        "POST",
        "/workspaces",
        json!({"name":"Second"}),
    )
    .await;
    assert_eq!(create.status, 201, "{}", create.json);
    let target = create.json["id"].as_str().unwrap();
    let added = call(
        &site.app,
        member,
        "POST",
        &format!("/workspaces/{target}/documents"),
        json!({"path":"one.md","markdown":ORIGINAL,"baseRevision":null}),
    )
    .await;
    assert_eq!(added.status, 201, "{}", added.json);
    let target_doc = added.json["document"]["id"].as_str().unwrap();
    let conversation = call(
        &site.app,
        member,
        "POST",
        "/ai/conversations",
        json!({"scope":"global"}),
    )
    .await;
    assert_eq!(conversation.status, 201, "{}", conversation.json);
    let turns = format!(
        "/ai/conversations/{}/turns",
        conversation.json["id"].as_str().unwrap()
    );
    let turn = call(
        &site.app,
        member,
        "POST",
        &turns,
        json!({
            "clientTurnId":"global-update", "mode":"edit", "prompt":"修改 Second 的 one.md"
        }),
    )
    .await;
    assert_eq!(turn.status, 202, "{}", turn.json);
    let operation_id = turn.json["operationId"].as_str().unwrap();
    let claim = site.claim(V2, OWNER).await;
    assert_eq!(claim.status, 200, "{}", claim.json);
    let base = format!("{V2}/claims/{}", claim.json["leaseId"].as_str().unwrap());
    let spaces = call(
        &site.app,
        OWNER,
        "GET",
        &format!("{base}/workspaces"),
        Value::Null,
    )
    .await;
    assert_eq!(spaces.status, 200);
    for id in [site.workspace.as_str(), target] {
        let docs = call(
            &site.app,
            OWNER,
            "GET",
            &format!("{base}/documents?workspaceId={id}"),
            Value::Null,
        )
        .await;
        assert_eq!(docs.status, 200, "{}", docs.json);
    }
    let source = call(
        &site.app,
        OWNER,
        "POST",
        &format!("{base}/sources"),
        json!({"workspaceId":site.workspace,"documentId":site.doc}),
    )
    .await;
    assert_eq!(source.status, 200, "{}", source.json);
    let revision = &source.json["source"]["revision"];
    let update = json!({"answer":"已更新","targetWorkspaceId":target,"edits":[
        {"path":"one.md","baseRevision":revision,"markdown":"第二空间的新内容。"},
        {"path":"summary.md","baseRevision":null,"markdown":"读数汇总。"}
    ]});
    let result = format!("{base}/result");
    let denied = call(&site.app, OWNER, "PUT", &result, update.clone()).await;
    assert_eq!(denied.status, 422, "{}", denied.json);
    let second = call(
        &site.app,
        OWNER,
        "POST",
        &format!("{base}/sources"),
        json!({"workspaceId":target,"documentId":target_doc}),
    )
    .await;
    assert_eq!(second.status, 200, "{}", second.json);
    assert_eq!(second.json["source"]["revision"], *revision);
    let saved = call(&site.app, OWNER, "PUT", &result, update.clone()).await;
    assert_eq!(saved.status, 200, "{}", saved.json);
    assert_eq!(saved.json["writeResult"]["created"], 1);
    assert_eq!(saved.json["writeResult"]["updated"], 1);
    let replay = call(&site.app, OWNER, "PUT", &result, update).await;
    assert_eq!(replay.json["commitId"], saved.json["commitId"]);
    let diff = call(
        &site.app,
        member,
        "GET",
        &format!("/ai/operations/{operation_id}/diff?path=one.md"),
        Value::Null,
    )
    .await;
    assert_eq!(diff.status, 200, "{}", diff.json);
    assert!(diff.json["diff"]
        .as_str()
        .unwrap()
        .contains("第二空间的新内容"));
    let undo = call(
        &site.app,
        member,
        "POST",
        &format!("/ai/operations/{operation_id}/undo"),
        json!({}),
    )
    .await;
    assert_eq!(undo.status, 200, "{}", undo.json);
    assert_eq!(undo.json["workspaceId"], target);
    let restored = call(
        &site.app,
        member,
        "GET",
        &format!("/documents/{target_doc}"),
        Value::Null,
    )
    .await;
    assert_eq!(restored.json["markdown"], ORIGINAL);
    site.original();
}
