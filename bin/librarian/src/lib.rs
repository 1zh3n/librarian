mod assets;

use std::sync::Arc;

use axum::Router;
use silverbullet_server::product::router::{
    build_configured_product_router, build_product_router, ProductState,
};

pub fn router() -> Router {
    build_product_router(product_state())
}

fn product_state() -> Arc<ProductState> {
    Arc::new(ProductState {
        version: env!("CARGO_PKG_VERSION"),
        asset: assets::reader_asset,
    })
}

mod mcp;

use std::path::Path;

use silverbullet_server::{multi::manager::MultiManager, product::space_adapter::NativeSpaces};
use silverbullet_server_mcp::MultiHost;

pub struct Product {
    manager: Arc<MultiManager>,
    host: Arc<MultiHost>,
    router: Router,
}

impl Product {
    pub fn open(data_root: &Path, port: u16) -> Result<Self, String> {
        let spaces = NativeSpaces::open(data_root, port, env!("CARGO_PKG_VERSION"))?;
        let (host, mcp_router) = mcp::build(data_root, &spaces)?;
        let manager = spaces.manager.clone();
        let router =
            build_configured_product_router(product_state(), data_root, spaces)?.merge(mcp_router);
        Ok(Self {
            manager,
            host,
            router,
        })
    }

    pub fn manager(&self) -> &MultiManager {
        &self.manager
    }

    pub fn space_host(&self) -> &MultiHost {
        &self.host
    }

    pub fn router(&self) -> Router {
        self.router.clone()
    }
}
