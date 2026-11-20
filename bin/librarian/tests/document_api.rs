use std::{fs, path::Path};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use silverbullet_server::multi::users::{Profile, UserStore};
use tempfile::TempDir;
use tower::ServiceExt;

const MARKDOWN: &str = "\u{feff}笔记\r\n\n第二行  \r";

struct Fixture {
    root: TempDir,
    editor: String,
    reader: String,
    outsider: String,
    app: Router,
}

fn open(root: &Path) -> Router {
    librarian::Product::open(root, 0).unwrap().router()
}

impl Fixture {
    fn new(root_space: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let users = UserStore::create_empty(root.path()).unwrap();
        for name in ["editor", "reader", "outsider"] {
            users
                .create_user(name, "local-test-password", false, Profile::default())
                .unwrap();
        }
        for (folder, text) in [("left", MARKDOWN.as_bytes()), ("right", b"other")] {
            let path = root.path().join("spaces").join(folder);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("Note.md"), text).unwrap();
            fs::write(path.join("Empty.md"), "").unwrap();
            fs::write(path.join("Invalid.md"), [255]).unwrap();
            fs::write(
                path.join(format!("{folder}-journal.md")),
                format!("---\r\ntitle: 田野日记\r\n---\r\n{folder} 河边鸟鸣。"),
            )
            .unwrap();
            fs::write(path.join("Note.outline.md"), "自由提纲，鸟鸣。").unwrap();
        }
        let mut spaces = json!({
            "left": {"name":"Left","access":"none","binding":{"prefix":"/left"},
                "members":{"editor":{"role":"write"},"reader":{"role":"read"}}},
            "right": {"name":"Right","access":"none","binding":{"prefix":"/right"},
                "members":{"editor":{"role":"write"},"outsider":{"role":"write"}}}
        });
        if root_space {
            spaces.as_object_mut().unwrap().remove("right");
            spaces["left"]["folder"] = json!(".");
            spaces["left"]["revisions"] = json!("managed");
            fs::create_dir_all(root.path().join(".librarian")).unwrap();
            fs::write(root.path().join(".librarian/Hidden.md"), "隐藏鸟鸣").unwrap();
        }
        fs::write(root.path().join("spaces.json"), spaces.to_string()).unwrap();
        let editor = users.create_token("editor", "test").unwrap();
        let reader = users.create_token("reader", "test").unwrap();
        let outsider = users.create_token("outsider", "test").unwrap();
        let app = open(root.path());
        Self {
            root,
            editor,
            reader,
            outsider,
            app,
        }
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, 2_000_000).await.unwrap();
        (
            parts.status,
            serde_json::from_slice(&bytes).unwrap_or_default(),
        )
    }

    async fn workspace(&self, name: &str) -> String {
        let (status, list) = self
            .request("GET", "/workspaces", Some(&self.editor), Value::Null)
            .await;
        assert_eq!(status, StatusCode::OK, "{list}");
        list.as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }

    async fn document(&self, workspace: &str, name: &str) -> String {
        let (status, list) = self
            .request(
                "GET",
                &format!("/workspaces/{workspace}/documents"),
                Some(&self.editor),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{list}");
        list.as_array()
            .unwrap()
            .iter()
            .find(|row| row["path"] == name)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
}

#[tokio::test]
async fn workspace_search_is_scoped() {
    for root_space in [false, true] {
        let fixture = Fixture::new(root_space);
        let workspace = fixture.workspace("Left").await;
        let endpoint = format!("/workspaces/{workspace}/search?q=%E9%B8%9F%E9%B8%A3");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6);
        let result = loop {
            let (status, result) = fixture
                .request("GET", &endpoint, Some(&fixture.reader), Value::Null)
                .await;
            assert!(
                matches!(status, StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE),
                "{status} {result}"
            );
            if status == StatusCode::OK && result.as_array().is_some_and(|hits| !hits.is_empty()) {
                break result;
            }
            assert!(tokio::time::Instant::now() < deadline, "{result}");
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        let hits = result.as_array().unwrap();
        assert!(
            hits.iter().any(|hit| {
                hit["document"]["path"]
                    .as_str()
                    .unwrap()
                    .ends_with("left-journal.md")
                    && hit["document"]["title"] == "田野日记"
                    && hit["excerpt"].as_str().unwrap().contains("鸟鸣")
            }),
            "{hits:?}"
        );
        assert!(!result.to_string().contains(".outline.md"));
        assert!(!result.to_string().contains("Hidden.md"));
        if !root_space {
            assert_eq!(hits.len(), 1);
            let document = fixture.document(&workspace, "left-journal.md").await;
            assert_eq!(hits[0]["document"]["id"], document);
            assert_eq!(
                fixture
                    .request("GET", &endpoint, Some(&fixture.outsider), Value::Null)
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
        }
    }
}

#[tokio::test]
async fn outline_and_body_save_independently() {
    let f = Fixture::new(false);
    let workspace = f.workspace("Left").await;
    let document = f.document(&workspace, "Empty.md").await;
    let body_path = format!("/documents/{document}");
    let outline_path = format!("{body_path}/outline");
    let read = |path| f.request("GET", path, Some(&f.reader), Value::Null);
    let (status, outline) = read(&outline_path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(outline, json!({"markdown":"","revision":null}));
    let (_, body) = read(&body_path).await;
    let text = "\u{feff}提纲\r\n正文待补  \n";
    let write = |path, value| f.request("PUT", path, Some(&f.editor), value);
    let (status, outline) =
        write(&outline_path, json!({"markdown":text,"baseRevision":null})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(outline["markdown"], text);
    assert!(outline["revision"]
        .as_str()
        .is_some_and(|hash| hash.len() == 64));
    assert_eq!(read(&body_path).await.1["revision"], body["revision"]);
    let (status, saved_body) = write(
        &body_path,
        json!({"markdown":"正文\r\n","baseRevision":body["revision"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved_body["document"]["outlineEnabled"], true);
    assert_eq!(read(&outline_path).await.1, outline);
    assert_eq!(
        fs::read(f.root.path().join("spaces/left/Empty.outline.md")).unwrap(),
        text.as_bytes()
    );
    assert_eq!(
        write(
            &outline_path,
            json!({"markdown":"冲突","baseRevision":null})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.request(
            "PUT",
            &outline_path,
            Some(&f.reader),
            json!({"markdown":"修改","baseRevision":outline["revision"]})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        write(&outline_path, json!({"markdown":"缺少条件"})).await.0,
        StatusCode::PRECONDITION_REQUIRED
    );
}

#[tokio::test]
async fn workspace_list_is_member_filtered() {
    let f = Fixture::new(false);
    let (status, list) = f
        .request("GET", "/workspaces", Some(&f.reader), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["name"], "Left");
    assert_eq!(list[0]["defaults"]["outlineEnabled"], false);
    let right = f.workspace("Right").await;
    assert_eq!(
        f.request(
            "GET",
            &format!("/workspaces/{right}/documents"),
            Some(&f.reader),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request("GET", "/workspaces", None, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn legacy_markdown_opens_without_front_matter() {
    let mut f = Fixture::new(false);
    let left = f.workspace("Left").await;
    let note = f.document(&left, "Note.md").await;
    let empty = f.document(&left, "Empty.md").await;
    let invalid = f.document(&left, "Invalid.md").await;
    f.app = open(f.root.path());
    assert_eq!(f.workspace("Left").await, left);
    assert_eq!(f.document(&left, "Note.md").await, note);
    let (_, snapshot) = f
        .request(
            "GET",
            &format!("/documents/{note}"),
            Some(&f.reader),
            Value::Null,
        )
        .await;
    assert_eq!(snapshot["markdown"], MARKDOWN);
    assert_eq!(snapshot["document"]["title"], "Note");
    assert_eq!(
        f.request(
            "GET",
            &format!("/documents/{empty}"),
            Some(&f.reader),
            Value::Null
        )
        .await
        .1["markdown"],
        ""
    );
    assert_eq!(
        f.request(
            "GET",
            &format!("/documents/{invalid}"),
            Some(&f.reader),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn same_path_in_two_spaces_has_distinct_identity() {
    let f = Fixture::new(false);
    let left = f.document(&f.workspace("Left").await, "Note.md").await;
    let right = f.document(&f.workspace("Right").await, "Note.md").await;
    assert_ne!(left, right);
    assert_eq!(
        f.request(
            "GET",
            &format!("/documents/{left}"),
            Some(&f.outsider),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn create_refuses_existing_path() {
    let f = Fixture::new(false);
    let endpoint = format!("/workspaces/{}/documents", f.workspace("Left").await);
    let create = |name: &str| json!({"path":name,"markdown":"初稿","baseRevision":null});
    for existing in ["Note.md", "Invalid.md"] {
        assert_eq!(
            f.request("POST", &endpoint, Some(&f.editor), create(existing))
                .await
                .0,
            StatusCode::CONFLICT
        );
    }
    let (a, b) = tokio::join!(
        f.request("POST", &endpoint, Some(&f.editor), create("新建.md")),
        f.request("POST", &endpoint, Some(&f.editor), create("新建.md"))
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::CREATED, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::CREATED)
    ));
    assert_eq!(
        fs::read_to_string(f.root.path().join("spaces/left/新建.md")).unwrap(),
        "初稿"
    );
}

#[tokio::test]
async fn openapi_describes_live_document_responses() {
    let f = Fixture::new(false);
    let specification: Value =
        serde_json::from_str(include_str!("../../../api/librarian.openapi.json")).unwrap();
    let workspace = f.workspace("Left").await;
    let document = f.document(&workspace, "Note.md").await;
    let (workspace_status, workspaces) = f
        .request("GET", "/workspaces", Some(&f.editor), Value::Null)
        .await;
    let (snapshot_status, snapshot) = f
        .request(
            "GET",
            &format!("/documents/{document}"),
            Some(&f.editor),
            Value::Null,
        )
        .await;
    let (query_status, error) = f
        .request(
            "GET",
            &format!("/workspaces/{workspace}/documents?limit=0"),
            Some(&f.editor),
            Value::Null,
        )
        .await;
    for (route, status, response) in [
        ("/workspaces", workspace_status, &workspaces),
        ("/documents/{document}", snapshot_status, &snapshot),
        ("/workspaces/{workspace}/documents", query_status, &error),
    ] {
        let schema = &specification["paths"][route]["get"]["responses"][status.as_str()]["content"]
            ["application/json"]["schema"];
        assert!(
            schema.is_object(),
            "missing OpenAPI response for {route} {status}"
        );
        assert_response_shape(&specification, schema, response);
    }
    assert_eq!(query_status, StatusCode::UNPROCESSABLE_ENTITY);
}

fn assert_response_shape(specification: &Value, schema: &Value, actual: &Value) {
    if let Some(reference) = schema["$ref"].as_str() {
        let target = specification
            .pointer(reference.strip_prefix('#').unwrap())
            .unwrap();
        assert_response_shape(specification, target, actual);
        return;
    }
    match schema["type"].as_str().unwrap() {
        "array" => {
            for item in actual.as_array().expect("expected a response array") {
                assert_response_shape(specification, &schema["items"], item);
            }
        }
        "object" => {
            let fields = actual.as_object().expect("expected a response object");
            for field in schema["required"].as_array().unwrap() {
                let field = field.as_str().unwrap();
                assert!(fields.contains_key(field), "missing response field {field}");
            }
            for (field, value) in fields {
                assert_response_shape(specification, &schema["properties"][field], value);
            }
        }
        "string" => assert!(actual.is_string(), "expected a string, got {actual}"),
        "boolean" => assert!(actual.is_boolean(), "expected a boolean, got {actual}"),
        kind => panic!("unhandled response schema type {kind}"),
    }
}

#[tokio::test]
async fn stale_put_keeps_server_body() {
    let f = Fixture::new(false);
    let left = f.workspace("Left").await;
    let path = format!("/documents/{}", f.document(&left, "Note.md").await);
    let (_, before) = f.request("GET", &path, Some(&f.editor), Value::Null).await;
    let body = json!({"markdown":"新\r\n","baseRevision":before["revision"]});
    assert_eq!(
        f.request("PUT", &path, Some(&f.reader), body.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, updated) = f.request("PUT", &path, Some(&f.editor), body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = f.request("PUT", &path, Some(&f.editor), body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["currentRevision"], updated["revision"]);
    assert_eq!(
        fs::read(f.root.path().join("spaces/left/Note.md")).unwrap(),
        "新\r\n".as_bytes()
    );
}

#[tokio::test]
async fn missing_base_revision_is_rejected() {
    let f = Fixture::new(false);
    let left = f.workspace("Left").await;
    let path = format!("/documents/{}", f.document(&left, "Note.md").await);
    assert_eq!(
        f.request("PUT", &path, Some(&f.editor), json!({"markdown":"修改"}))
            .await
            .0,
        StatusCode::PRECONDITION_REQUIRED
    );
}

#[tokio::test]
async fn root_space_excludes_product_state() {
    let f = Fixture::new(true);
    let left = f.workspace("Left").await;
    let endpoint = format!("/workspaces/{left}/documents");
    let (status, list) = f
        .request("GET", &endpoint, Some(&f.editor), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!list.to_string().contains("Hidden.md"));
    assert_eq!(
        f.request(
            "POST",
            &endpoint,
            Some(&f.editor),
            json!({"path":".librarian/New.md","markdown":"hidden","baseRevision":null})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn browser_login_binds_writes_to_the_product_origin() {
    let f = Fixture::new(false);
    let workspace = f.workspace("Left").await;
    let login = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/.auth/librarian/login?next=%2F")
                .header("host", "127.0.0.1")
                .header("origin", "http://127.0.0.1")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from("username=editor&password=local-test-password"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::SEE_OTHER);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    for (origin, status) in [
        ("http://example.test", StatusCode::FORBIDDEN),
        ("http://127.0.0.1", StatusCode::CREATED),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/workspaces/{workspace}/documents"))
                    .header("host", "127.0.0.1")
                    .header("origin", origin)
                    .header("cookie", cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"path":"Cookie.md","markdown":"原文","baseRevision":null})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
}
