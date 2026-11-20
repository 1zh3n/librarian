use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use clap::{Parser, Subcommand};
use reqwest::{blocking::Client, Url};
use serde_json::{json, Value};
use walkdir::WalkDir;

const MAX_FILES: usize = 64;
const MAX_MARKDOWN: usize = 4 * 1024 * 1024;
const MAX_ASSET: usize = 12 * 1024 * 1024;
const MAX_ARCHIVE: usize = 18 * 1024 * 1024;
const MAX_REQUEST: usize = 33 * 1024 * 1024;

#[derive(Parser)]
#[command(name = "docs", about = "Deliver documents to a Librarian Workspace")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Upload a local document, directory, or ZIP archive.
    Push(Push),
}

#[derive(clap::Args)]
struct Push {
    path: PathBuf,
    #[arg(long)]
    workspace: String,
    #[arg(long)]
    delivery_id: String,
    #[arg(long)]
    source_name: String,
    #[arg(long)]
    version: Option<String>,
    #[arg(long)]
    generated_at: Option<String>,
    #[arg(long)]
    url: Option<Url>,
}

fn main() -> ExitCode {
    let Args { command } = Args::parse();
    let Command::Push(push) = command;
    match submit(push) {
        Ok(result) => {
            println!("{result}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("docs: {error}");
            ExitCode::FAILURE
        }
    }
}

fn submit(push: Push) -> Result<String, Box<dyn std::error::Error>> {
    let token = std::env::var("LIBRARIAN_DELIVERY_TOKEN").map_err(|_| {
        invalid("Set LIBRARIAN_DELIVERY_TOKEN to the Workspace delivery credential")
    })?;
    if token.is_empty() {
        return Err(invalid("LIBRARIAN_DELIVERY_TOKEN must be set").into());
    }
    let url = match push.url {
        Some(url) => url,
        None => std::env::var("LIBRARIAN_URL")
            .map_err(|_| invalid("Set LIBRARIAN_URL or pass --url"))?
            .parse()?,
    };
    let endpoint = delivery_url(url, &push.workspace)?;
    let manifest = json!({
        "deliveryId": push.delivery_id,
        "sourceName": push.source_name,
        "version": push.version,
        "generatedAt": push.generated_at,
    });
    let data = serde_json::to_vec(&payload(&push.path, manifest)?)?;
    if data.len() > MAX_REQUEST {
        return Err(invalid("The encoded delivery exceeds the request size limit").into());
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(90))
        .build()?;
    let response = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .bearer_auth(token)
        .body(data)
        .send()?;
    let status = response.status();
    let mut bytes = Vec::new();
    response.take(256 * 1024).read_to_end(&mut bytes)?;
    if !status.is_success() {
        let code = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|body| {
                body["code"]
                    .as_str()
                    .filter(|code| {
                        code.len() <= 64
                            && code
                                .bytes()
                                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                    })
                    .map(str::to_owned)
            });
        let reason = code.unwrap_or_else(|| "delivery_rejected".to_owned());
        return Err(invalid(format!("Librarian returned {status} ({reason})")).into());
    }
    let receipt: Value = serde_json::from_slice(&bytes)?;
    if !receipt["commitId"].is_string() || !receipt["operationId"].is_string() {
        return Err(invalid("Librarian did not return a valid delivery receipt").into());
    }
    Ok(serde_json::to_string_pretty(&receipt)?)
}

fn delivery_url(mut url: Url, workspace: &str) -> Result<Url, io::Error> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "Expected a Librarian HTTP base URL without credentials",
        ));
    }
    url.path_segments_mut()
        .map_err(|_| invalid("Invalid base URL"))?
        .pop_if_empty()
        .extend(["api", "v1", "workspaces", workspace, "deliveries"]);
    Ok(url)
}

fn payload(path: &Path, manifest: Value) -> io::Result<Value> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_file()
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        let archive = read_limited(path, MAX_ARCHIVE)?;
        return Ok(json!({"manifest":manifest,"archiveBase64":STANDARD.encode(archive)}));
    }
    let mut files = Vec::new();
    let mut total = 0;
    if metadata.is_dir() {
        let entries = WalkDir::new(path)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            });
        for entry in entries {
            let entry = entry.map_err(io::Error::other)?;
            if entry.file_type().is_dir() {
                continue;
            }
            let relative = entry.path().strip_prefix(path).map_err(io::Error::other)?;
            append_file(&mut files, &mut total, entry.path(), relative)?;
        }
    } else {
        let name = path
            .file_name()
            .ok_or_else(|| invalid("Expected a file name"))?;
        append_file(&mut files, &mut total, path, Path::new(name))?;
    }
    if files.is_empty() {
        return Err(invalid("No files found in the selected path"));
    }
    Ok(json!({"manifest":manifest,"files":files}))
}

fn append_file(
    files: &mut Vec<Value>,
    total: &mut usize,
    path: &Path,
    relative: &Path,
) -> io::Result<()> {
    if files.len() >= MAX_FILES {
        return Err(invalid("A delivery can contain at most 64 files"));
    }
    let path_string = relative
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or_else(|| invalid("File paths must use UTF-8"))
        })
        .collect::<io::Result<Vec<_>>>()?
        .join("/");
    let limit = if path_string.to_ascii_lowercase().ends_with(".md") {
        MAX_MARKDOWN
    } else {
        MAX_ASSET
    };
    let data = read_limited(path, limit)?;
    *total += data.len();
    if *total > 24 * 1024 * 1024 {
        return Err(invalid(
            "File contents exceed the delivery request size limit",
        ));
    }
    files.push(json!({"path":path_string,"contentBase64":STANDARD.encode(data)}));
    Ok(())
}

fn read_limited(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.is_symlink() {
        return Err(invalid("Deliver only regular files without symbolic links"));
    }
    if meta.len() > limit as u64 {
        return Err(invalid("A file exceeds the delivery size limit"));
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path)?
        .take((limit + 1) as u64)
        .read_to_end(&mut data)?;
    if data.len() > limit {
        return Err(invalid("A file exceeds the delivery size limit"));
    }
    Ok(data)
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_keeps_relative_paths_and_attachment_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir(root.join("images")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "not part of the delivery").unwrap();
        fs::write(root.join("笔记.md"), "\u{feff}原稿\r\n").unwrap();
        fs::write(root.join("images/example.bin"), [0, 1, 255]).unwrap();
        let request = payload(root, json!({})).unwrap();
        let files = request["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["path"], "images/example.bin");
        assert_eq!(files[0]["contentBase64"], "AAH/");
        assert_eq!(files[1]["path"], "笔记.md");
        assert_eq!(
            files[1]["contentBase64"],
            STANDARD.encode("\u{feff}原稿\r\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_does_not_follow_symbolic_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("folder");
        fs::create_dir(&root).unwrap();
        fs::write(temp.path().join("private"), "outside selected folder").unwrap();
        std::os::unix::fs::symlink(temp.path().join("private"), root.join("link.md")).unwrap();
        assert!(payload(&root, json!({})).is_err());
    }

    #[test]
    fn endpoint_encodes_the_workspace_as_one_segment() {
        let url = delivery_url(
            "https://server.example/librarian/".parse().unwrap(),
            "ws_a/b",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://server.example/librarian/api/v1/workspaces/ws_a%2Fb/deliveries"
        );
        assert!(delivery_url("https://user:secret@server.example".parse().unwrap(), "ws").is_err());
    }
}
