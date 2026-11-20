//! Compile-time-embedded client bundle + `base_fs`, exposed as read-only
//! `SpacePrimitives` so the whole UI ships inside the single static binary.

use rust_embed::RustEmbed;
pub use silverbullet_server_common::space::EmbeddedSpace;
#[cfg(test)]
use silverbullet_server_common::{SpaceError, SpacePrimitives};

// Source maps outweigh the code they describe, so release binaries leave them
// out. Debug builds read these folders from disk, maps included, so DevTools
// keeps them in development.

/// The built client web UI (`client_bundle/client`), served at the SPA fallback.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../client_bundle/client"]
#[cfg_attr(not(debug_assertions), exclude = "*.map")]
pub struct ClientAssets;

/// The bundled default space content (`client_bundle/base_fs`) — a read-only
/// underlay beneath the user's disk files.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../client_bundle/base_fs"]
#[cfg_attr(not(debug_assertions), exclude = "*.map")]
pub struct BaseFsAssets;

#[cfg(test)]
mod tests {
    use super::*;
    use silverbullet_server_common::space::BUNDLED_COPY_ON_WRITE;

    #[test]
    fn client_bundle_contains_index_html() {
        let space = EmbeddedSpace::<ClientAssets>::new();
        let (data, meta) = space.read_file(".client/index.html").unwrap();
        assert!(!data.is_empty());
        assert!(meta.content_type.contains("html"), "{}", meta.content_type);
    }

    #[test]
    fn missing_file_is_not_found() {
        let space = EmbeddedSpace::<ClientAssets>::new();
        assert!(matches!(
            space.read_file("does/not/exist.xyz"),
            Err(SpaceError::NotFound)
        ));
    }

    #[test]
    fn writes_are_rejected() {
        let space = EmbeddedSpace::<ClientAssets>::new();
        assert!(space.write_file("x", b"y", None).is_err());
    }

    #[test]
    fn copy_on_write_prefixes_are_rw() {
        let space = EmbeddedSpace::<BaseFsAssets>::new().with_copy_on_write(BUNDLED_COPY_ON_WRITE);
        assert_eq!(
            space
                .get_file_meta("Library/Repository/Std.md")
                .unwrap()
                .perm,
            "rw"
        );
        assert_eq!(
            space.get_file_meta("Library/Std/Config.md").unwrap().perm,
            "ro"
        );
    }

    #[test]
    fn file_list_is_nonempty() {
        let space = EmbeddedSpace::<ClientAssets>::new();
        assert!(!space.fetch_file_list().unwrap().is_empty());
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "debug builds read the bundle from disk")]
    fn release_bundles_leave_out_source_maps() {
        assert!(ClientAssets::iter().all(|p| !p.ends_with(".map")));
        assert!(BaseFsAssets::iter().all(|p| !p.ends_with(".map")));
        assert!(ClientAssets::get(".client/client.js").is_some());
    }
}
