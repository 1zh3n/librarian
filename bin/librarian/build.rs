use std::path::Path;

fn main() {
    let bundle = "../../apps/reader/dist";
    println!("cargo:rerun-if-changed={bundle}");
    assert!(
        Path::new(bundle).join("index.html").is_file(),
        "Reader bundle missing. Run npm run build -w @librarian/reader from the fork root."
    );
}
