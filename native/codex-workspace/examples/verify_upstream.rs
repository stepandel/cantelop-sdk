//! Verify every pinned upstream migration through the SDK bridge.
use cantelop_codex_workspace::{WorkspaceConnectOptions, WorkspacePoolOptions};
use sqlx::migrate::Migrator;
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = PathBuf::from(std::env::args_os().nth(1).ok_or("Codex source path required")?).join("codex-rs/state");
    let options = WorkspaceConnectOptions::from_environment()?;
    for (namespace, directory) in [
        ("state", "migrations"), ("logs", "logs_migrations"), ("goals", "goals_migrations"),
        ("memories", "memory_migrations"), ("memories_v2", "memory_migrations"),
        ("queue", "queue_migrations"), ("history", "thread_history_migrations"),
    ] {
        let pool = WorkspacePoolOptions::new().max_connections(2).connect_with(options.clone().namespace(namespace)?).await?;
        let migrations = Migrator::new(source.join(directory).as_path()).await?;
        migrations.run(&pool).await.map_err(|error| format!("{namespace} migrations failed: {error}"))?;
        // Reopen the migrated ledger, verifying recorded versions and checksums.
        migrations.run(&pool).await?;
        pool.close().await;
        println!("{namespace}: all pinned upstream migrations applied and reopened");
    }
    Ok(())
}
