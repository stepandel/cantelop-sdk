//! Cross-language integration check. Not a Codex harness executable.
use cantelop_codex_workspace::{Workspace, WorkspaceConnectOptions};
use sqlx::{ConnectOptions, Connection, Row};
use sqlx_core::{
    migrate::{Migrate, Migration, MigrationType},
    sql_str::SqlSafeStr,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = WorkspaceConnectOptions::from_environment()?;
    let mut connection = options.connect().await?;
    connection.lock().await?;
    connection
        .ensure_migrations_table("_sqlx_migrations")
        .await?;
    let migration = Migration::new(1, "bridge verification".into(), MigrationType::Simple,
        "CREATE TABLE threads (id TEXT PRIMARY KEY, amount INTEGER NOT NULL, payload BLOB, optional TEXT)".into_sql_str(), false);
    connection.apply("_sqlx_migrations", &migration).await?;
    connection.unlock().await?;
    {
        let mut transaction = connection.begin().await?;
        sqlx::query::<Workspace>("INSERT INTO threads (id, amount, payload) VALUES (?, ?, ?)")
            .bind("durable")
            .bind(i64::MAX)
            .bind(vec![0u8, 255u8])
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    }
    {
        let mut transaction = connection.begin().await?;
        sqlx::query::<Workspace>("INSERT INTO threads (id, amount) VALUES ('discarded', 1)")
            .execute(&mut *transaction)
            .await?;
        // SQLx's transaction Drop must roll back before the connection can be reused.
    }
    connection.ping().await?;
    let row =
        sqlx::query::<Workspace>("SELECT amount, payload, optional FROM threads WHERE id = ?")
            .bind("durable")
            .fetch_one(&mut connection)
            .await?;
    assert_eq!(row.try_get::<i64, _>("amount")?, i64::MAX);
    assert_eq!(row.try_get::<Vec<u8>, _>("payload")?, vec![0, 255]);
    assert_eq!(row.try_get::<Option<String>, _>("optional")?, None);
    let count = sqlx::query_scalar::<Workspace, i64>("SELECT COUNT(*) FROM threads")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(count, 1);
    let migrations = connection
        .list_applied_migrations("_sqlx_migrations")
        .await?;
    assert_eq!(migrations.len(), 1);
    assert_eq!(migrations[0].checksum.as_ref(), migration.checksum.as_ref());
    connection.close().await?;
    let mut logs = options.clone().namespace("logs")?.connect().await?;
    logs.lock().await?;
    logs.ensure_migrations_table("_sqlx_migrations").await?;
    assert!(
        logs.list_applied_migrations("_sqlx_migrations")
            .await?
            .is_empty(),
        "each upstream database has an independent ledger"
    );
    logs.unlock().await?;
    logs.close().await?;
    let mut readonly = options.read_only().connect().await?;
    assert!(sqlx::query::<Workspace>("DELETE FROM threads").execute(&mut readonly).await.is_err());
    assert!(readonly.execute_multiple("DELETE FROM threads").await.is_err());
    assert!(readonly.begin().await.is_err());
    assert_eq!(sqlx::query_scalar::<Workspace, i64>("SELECT COUNT(*) FROM threads").fetch_one(&mut readonly).await?, 1);
    readonly.close().await?;
    println!("Native SQLx driver: values, commit, rollback, scoped schema and migrations verified");
    Ok(())
}
