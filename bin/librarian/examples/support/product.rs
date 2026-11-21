use std::{io, path::Path};

pub fn open(root: &Path, port: u16) -> io::Result<librarian::Product> {
    // The browser fixtures launch <profile>/examples/reader_* alongside <profile>/librarian.
    let example = std::env::current_exe()?;
    let profile = example
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| io::Error::other("Missing Cargo profile directory for Reader fixture"))?;
    let parser = profile.join(format!("librarian{}", std::env::consts::EXE_SUFFIX));
    librarian::Product::open_with_material_parser(root, port, &parser).map_err(io::Error::other)
}
