use std::path::Path;

fn main() {
    let bundle = "../../apps/reader/dist";
    println!("cargo:rerun-if-changed={bundle}");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    assert!(
        ["index.html", "login.html"]
            .iter()
            .all(|entry| Path::new(bundle).join(entry).is_file()),
        "Reader bundle missing. Run npm run build -w @librarian/reader from the fork root."
    );
}
