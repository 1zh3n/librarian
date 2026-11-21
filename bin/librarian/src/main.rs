mod ai_materials;

use std::{
    io::{self, BufRead, Read},
    net::SocketAddr,
    path::PathBuf,
};

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(version, about = "Librarian document workspace")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8080")]
    listen: SocketAddr,
    #[arg(long, global = true)]
    data_root: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    #[command(hide = true)]
    MaterialParser { format: String },
    /// Set up the first local administrator with a password received on stdin.
    Init {
        #[arg(long, default_value = "admin")]
        username: String,
    },
}

fn main() -> std::io::Result<()> {
    let args = Args::parse();
    if let Some(Command::MaterialParser { format }) = args.command {
        return ai_materials::worker(&format);
    }
    serve(args)
}

#[tokio::main]
async fn serve(args: Args) -> io::Result<()> {
    if let Some(Command::Init { username }) = args.command {
        let root = args.data_root.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "init requires --data-root")
        })?;
        let mut password = String::new();
        io::stdin().lock().take(4098).read_line(&mut password)?;
        if password.ends_with('\n') {
            password.pop();
            if password.ends_with('\r') {
                password.pop();
            }
        }
        if password.is_empty() || password.len() > 4096 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Provide a password up to 4096 bytes on stdin",
            ));
        }
        silverbullet_server::product::space_adapter::initialize_data_root(
            &root, &username, &password,
        )
        .map_err(io::Error::other)?;
        println!("Librarian administrator created");
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    let address = listener.local_addr()?;
    let router = match args.data_root {
        Some(root) => librarian::Product::open(&root, address.port())
            .map_err(std::io::Error::other)?
            .router(),
        None => librarian::router(),
    };
    eprintln!("Librarian listening on {address}");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
