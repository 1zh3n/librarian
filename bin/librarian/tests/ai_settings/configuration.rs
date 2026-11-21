use super::*;

async fn settings(
    app: &App,
    who: &str,
    method: &str,
    route: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/api/v1/ai/settings{route}"))
                .header(header::ORIGIN, ORIGIN)
                .header(header::HOST, HOST)
                .header(header::COOKIE, who)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 512 * 1024).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(KEY));
    (
        parts.status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn rotating_key_requires_new_discovery_and_leaks_no_plaintext() {
    let provider =
        Provider::start(vec![Json(json!({"data":[{"id":"sample"}]})).into_response()]).await;
    let app = App::new(Some(&provider.addr));
    let admin = app.login("admin").await;
    let member = app.login("reader").await;
    let (_, ticket) = app.discover(&admin, ORIGIN, draft(&provider.base())).await;
    let mut input = json!({"label":"实验模型","provider":"deepseek","baseUrl":provider.base(),"discoveryId":ticket["discoveryId"],"keyChange":{"kind":"replace","apiKey":KEY}});
    assert_eq!(
        settings(&app, &member, "POST", "/connections", input.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    input["keyChange"]["apiKey"] = json!("different-key");
    assert_eq!(
        settings(&app, &admin, "POST", "/connections", input.clone())
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    input["keyChange"]["apiKey"] = json!(KEY);
    assert_eq!(
        settings(&app, &admin, "POST", "/connections", input)
            .await
            .0,
        StatusCode::CREATED
    );
    let (_, admin_view) = settings(&app, &admin, "GET", "", Value::Null).await;
    let connection = &admin_view["connections"][0];
    assert_eq!(connection["hasApiKey"], true);
    assert_eq!(connection["credentialAvailable"], true);
    assert_eq!(connection["enabled"], false);
    assert_eq!(admin_view["dispatchMode"], "legacy");
    let url = format!("/connections/{}", connection["id"].as_str().unwrap());
    assert_eq!(
        settings(
            &app,
            &admin,
            "PATCH",
            &url,
            json!({"expectedVersion":0,"label":"stale"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, member_view) = settings(&app, &member, "GET", "", Value::Null).await;
    assert_eq!(member_view["connections"], json!([]));
    let db = fs::read(app._root.path().join(".librarian/metadata.sqlite3")).unwrap();
    assert!(!db.windows(KEY.len()).any(|s| s == KEY.as_bytes()));
    fs::remove_file(app._root.path().join(".librarian/ai-install.key")).unwrap();
    let (_, missing) = settings(&app, &admin, "GET", "", Value::Null).await;
    assert_eq!(missing["connections"][0]["credentialAvailable"], false);
    assert_eq!(missing["dispatchMode"], "legacy");
}

#[tokio::test]
async fn settings_states_do_not_change_dispatch_mode() {
    let app = App::new(None);
    let admin = app.login("admin").await;
    for enabled in [false, true] {
        assert!(settings(
            &app,
            &admin,
            "PUT",
            "/global-enabled",
            json!({"enabled":enabled})
        )
        .await
        .0
        .is_success());
        let (status, view) = settings(&app, &admin, "GET", "", Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(view["dispatchMode"], "legacy");
        assert_eq!(view["globalEnabled"], enabled);
    }
}

#[tokio::test]
async fn selection_falls_back_after_catalog_removal() {
    let catalog = |ids: Value| Json(json!({"data":ids})).into_response();
    let provider = Provider::start(vec![
        catalog(json!([{"id":"a","effort":{"supported_levels":["high"]}},{"id":"b"}])),
        catalog(json!([{"id":"a"},{"id":"b"}])),
        catalog(json!([{"id":"b"}])),
    ])
    .await;
    let app = App::new(Some(&provider.addr));
    let admin = app.login("admin").await;
    let member = app.login("reader").await;
    let (_, ticket) = app.discover(&admin, ORIGIN, draft(&provider.base())).await;
    let (status,created)=settings(&app,&admin,"POST","/connections",json!({"label":"样本","provider":"deepseek","baseUrl":provider.base(),"discoveryId":ticket["discoveryId"],"keyChange":{"kind":"replace","apiKey":KEY}})).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_str().unwrap();
    let connection = format!("/connections/{id}");
    assert!(settings(
        &app,
        &admin,
        "PATCH",
        &connection,
        json!({"enabled":true,"expectedVersion":1})
    )
    .await
    .0
    .is_success());
    let choose = |model: &str, thinking: Value| json!({"connectionId":id,"modelId":model,"thinking":thinking});
    let pref = choose("a", json!({"mode":"effort","level":"high"}));
    assert!(settings(
        &app,
        &member,
        "PUT",
        "/preference",
        json!({"selection":pref})
    )
    .await
    .0
    .is_success());
    let saved = json!({"connectionId":id});
    assert!(app
        .discover(&admin, ORIGIN, saved.clone())
        .await
        .0
        .is_success());
    let (_, v) = settings(&app, &member, "GET", "", Value::Null).await;
    assert_eq!(
        v["effectiveSelection"],
        choose("a", json!({"mode":"provider_default"}))
    );
    assert_eq!(v["fallbackReason"], "effort_unavailable");
    assert!(app.discover(&admin, ORIGIN, saved).await.0.is_success());
    let (_, v) = settings(&app, &member, "GET", "", Value::Null).await;
    assert_eq!(v["effectiveSelection"], Value::Null);
    assert_eq!(v["fallbackReason"], "model_unavailable");
    assert!(v["connections"][0].get("baseUrl").is_none());
    assert!(v["connections"][0].get("hasApiKey").is_none());
}

#[tokio::test]
async fn activating_an_online_runner_commits_one_replayable_default_without_a_probe() {
    let provider =
        Provider::start(vec![Json(json!({"data":[{"id":"one"}]})).into_response()]).await;
    let app = App::new(Some(&provider.addr));
    let admin = app.login("admin").await;
    let reader = app.login("reader").await;
    let (_, discovery) = app.discover(&admin, ORIGIN, draft(&provider.base())).await;
    let (status, created) = settings(
        &app,
        &admin,
        "POST",
        "/connections",
        json!({
            "label":"样本","provider":"deepseek","baseUrl":provider.base(),
            "discoveryId":discovery["discoveryId"],"keyChange":{"kind":"replace","apiKey":KEY}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, original) = settings(&app, &admin, "GET", "", Value::Null).await;
    let selection = json!({"connectionId":created["id"],"modelId":"one","thinking":{"mode":"provider_default"}});
    let input = json!({"activationId":"first","expectedSettingsVersion":original["settingsVersion"],"selection":selection});
    let activate = |who: String, input: Value| {
        let app = &app;
        async move { settings(app, &who, "POST", "/managed-activation", input).await }
    };
    assert_eq!(
        activate(reader, input.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, error) = activate(admin.clone(), input.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "runner_offline");
    let (_, before) = settings(&app, &admin, "GET", "", Value::Null).await;
    assert_eq!(before, original);
    let db =
        rusqlite::Connection::open(app._root.path().join(".librarian/metadata.sqlite3")).unwrap();
    db.execute("INSERT INTO ai_runner_instances(id,token_digest,last_seen) VALUES('test-instance','synthetic-identity',unixepoch())",[]).unwrap();
    let mut stale = input.clone();
    stale["expectedSettingsVersion"] = json!(0);
    assert_eq!(
        activate(admin.clone(), stale.clone()).await.0,
        StatusCode::CONFLICT
    );
    let (status, receipt) = activate(admin.clone(), input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["activationId"], input["activationId"]);
    let (_, managed) = settings(&app, &admin, "GET", "", Value::Null).await;
    assert_eq!(managed["dispatchMode"], "managed");
    assert_eq!(managed["defaultSelection"], selection);
    assert_eq!(managed["connections"][0]["enabled"], true);
    assert_eq!(
        managed["settingsVersion"].as_i64(),
        original["settingsVersion"].as_i64().map(|v| v + 1)
    );
    assert_eq!(
        activate(admin.clone(), input.clone()).await,
        (StatusCode::OK, receipt)
    );
    assert_eq!(activate(admin.clone(), stale).await.0, StatusCode::CONFLICT);
    let mut other = input;
    other["activationId"] = json!("different");
    other["expectedSettingsVersion"] = managed["settingsVersion"].clone();
    assert_eq!(activate(admin, other).await.0, StatusCode::CONFLICT);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}
