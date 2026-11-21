mod assets;

use std::sync::Arc;

use axum::Router;
use silverbullet_server::product::router::{
    build_configured_product_router_with_parser, build_product_router, ProductState,
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
        Self::open_configured(data_root, port, None)
    }

    /// Run material workers with an explicit Librarian executable when embedding the product.
    pub fn open_with_material_parser(
        data_root: &Path,
        port: u16,
        parser: &Path,
    ) -> Result<Self, String> {
        Self::open_configured(data_root, port, Some(parser))
    }

    fn open_configured(data_root: &Path, port: u16, parser: Option<&Path>) -> Result<Self, String> {
        let spaces = NativeSpaces::open(data_root, port, env!("CARGO_PKG_VERSION"))?;
        let manager = spaces.manager.clone();
        let (product_router, bridge) = build_configured_product_router_with_parser(
            product_state(),
            data_root,
            spaces,
            parser,
        )?;
        let (host, mcp_router) = mcp::build(data_root, bridge)?;
        Ok(Self {
            manager,
            host,
            router: product_router.merge(mcp_router),
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
