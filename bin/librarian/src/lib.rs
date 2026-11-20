mod assets;

use std::sync::Arc;

use axum::Router;
use silverbullet_server::product::router::{build_product_router, ProductState};

pub fn router() -> Router {
    build_product_router(Arc::new(ProductState {
        version: env!("CARGO_PKG_VERSION"),
        asset: assets::reader_asset,
    }))
}
