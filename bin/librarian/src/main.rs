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
    /// Enroll a managed runner using a private local identity file.
    RunnerEnroll {
        #[arg(long)]
        identity_file: PathBuf,
    },
    /// Set up the first local administrator.
    Init {
        #[arg(long, default_value = "admin")]
        username: String,
        /// Print a one-time administrator invitation instead of reading a password.
        #[arg(long)]
        admin_invite: bool,
        /// HTTPS origin used in the invitation URL (or a loopback HTTP origin).
        #[arg(long)]
        public_url: Option<String>,
        /// Invitation lifetime in minutes (1-1440).
        #[arg(long, default_value_t = 60)]
        expires_in_minutes: u64,
    },
    /// Create a one-time administrator invitation in an existing data folder.
    AdminInvite {
        #[arg(long, default_value = "admin")]
        username: String,
        /// HTTPS origin used in the invitation URL (or a loopback HTTP origin).
        #[arg(long)]
        public_url: Option<String>,
        /// Invitation lifetime in minutes (1-1440).
        #[arg(long, default_value_t = 60)]
        expires_in_minutes: u64,
    },
}

fn main() -> std::io::Result<()> {
    let args = Args::parse();
    if let Some(Command::MaterialParser { format }) = args.command {
        return ai_materials::worker(&format);
    }
    if let Some(Command::RunnerEnroll { identity_file }) = &args.command {
        let root = args.data_root.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "runner-enroll requires --data-root",
            )
        })?;
        silverbullet_server::product::runner_enrollment::enroll(root, identity_file)?;
        println!("Librarian runner enrolled");
        return Ok(());
    }
    serve(args)
}

fn create_admin_invite(
    root: &std::path::Path,
    username: &str,
    public_url: Option<&str>,
    expires_in_minutes: u64,
    require_empty: bool,
) -> io::Result<()> {
    let minutes = expires_in_minutes.clamp(1, 1440);
    let invite = silverbullet_server::product::space_adapter::create_admin_invite(
        root,
        username,
        public_url,
        i64::try_from(minutes).unwrap_or(60) * 60,
        require_empty,
    )
    .map_err(io::Error::other)?;
    println!("Librarian administrator invitation created (expires in {minutes} minutes):");
    println!("{}", invite.url);
    println!("Open this one-time URL, set a password and TOTP, then save the recovery codes.");
    Ok(())
}

#[tokio::main]
async fn serve(args: Args) -> io::Result<()> {
    if let Some(Command::AdminInvite {
        username,
        public_url,
        expires_in_minutes,
    }) = args.command
    {
        let root = args.data_root.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "admin-invite requires --data-root",
            )
        })?;
        return create_admin_invite(
            &root,
            &username,
            public_url.as_deref(),
            expires_in_minutes,
            false,
        );
    }
    if let Some(Command::Init {
        username,
        admin_invite,
        public_url,
        expires_in_minutes,
    }) = args.command
    {
        let root = args.data_root.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "init requires --data-root")
        })?;
        if admin_invite {
            return create_admin_invite(
                &root,
                &username,
                public_url.as_deref(),
                expires_in_minutes,
                true,
            );
        }
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
