use std::net::SocketAddr;

use clap::Parser;

#[derive(Parser)]
#[command(version, about = "Librarian document workspace")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8080")]
    listen: SocketAddr,
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    eprintln!("Librarian listening on {}", listener.local_addr()?);
    axum::serve(listener, librarian::router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}
