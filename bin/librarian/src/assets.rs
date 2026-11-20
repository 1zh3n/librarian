use rust_embed::RustEmbed;
use silverbullet_server::product::router::ProductAsset;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../apps/reader/dist/"]
#[include = "index.html"]
#[include = "assets/*"]
struct ReaderAssets;

pub fn reader_asset(path: &str) -> Option<ProductAsset> {
    ReaderAssets::get(path).map(|asset| ProductAsset {
        bytes: asset.data,
        content_type: asset.metadata.mimetype().to_owned(),
    })
}
