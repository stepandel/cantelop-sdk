use crate::{Workspace, WorkspaceConnection, WorkspaceTransactionManager};
use futures_core::future::BoxFuture;
use sqlx::{AssertSqlSafe, Row};
use sqlx_core::{
    migrate::{AppliedMigration, Migrate, MigrateError, Migration},
    transaction::TransactionManager,
};
use std::{
    borrow::Cow,
    time::{Duration, Instant},
};

fn table(name: &str) -> Result<String, MigrateError> {
    if name != "_sqlx_migrations" {
        return Err(
            sqlx::Error::Protocol("custom migration table names are not supported".into()).into(),
        );
    }
    Ok(name.to_owned())
}
impl Migrate for WorkspaceConnection {
    fn create_schema_if_not_exists<'e>(
        &'e mut self,
        _: &'e str,
    ) -> BoxFuture<'e, Result<(), MigrateError>> {
        Box::pin(async {
            Err(sqlx::Error::Protocol("named SQL schemas are not supported".into()).into())
        })
    }
    fn ensure_migrations_table<'e>(
        &'e mut self,
        name: &'e str,
    ) -> BoxFuture<'e, Result<(), MigrateError>> {
        Box::pin(async move {
            let name = table(name)?;
            sqlx::query::<Workspace>(AssertSqlSafe(format!("CREATE TABLE IF NOT EXISTS {name} (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)")))
                .execute(self).await?;
            Ok(())
        })
    }
    fn dirty_version<'e>(
        &'e mut self,
        name: &'e str,
    ) -> BoxFuture<'e, Result<Option<i64>, MigrateError>> {
        Box::pin(async move {
            Ok(sqlx::query_scalar::<Workspace, i64>(AssertSqlSafe(format!(
                "SELECT version FROM {} WHERE success = 0 ORDER BY version LIMIT 1",
                table(name)?
            )))
            .fetch_optional(self)
            .await?)
        })
    }
    fn list_applied_migrations<'e>(
        &'e mut self,
        name: &'e str,
    ) -> BoxFuture<'e, Result<Vec<AppliedMigration>, MigrateError>> {
        Box::pin(async move {
            let rows = sqlx::query::<Workspace>(AssertSqlSafe(format!(
                "SELECT version, checksum FROM {} ORDER BY version",
                table(name)?
            )))
            .fetch_all(self)
            .await?;
            rows.iter()
                .map(|row| {
                    Ok(AppliedMigration {
                        version: row.try_get("version")?,
                        checksum: Cow::Owned(row.try_get::<Vec<u8>, _>("checksum")?),
                    })
                })
                .collect()
        })
    }
    fn lock(&mut self) -> BoxFuture<'_, Result<(), MigrateError>> {
        Box::pin(async move {
            WorkspaceTransactionManager::begin(self, None).await?;
            Ok(())
        })
    }
    fn unlock(&mut self) -> BoxFuture<'_, Result<(), MigrateError>> {
        Box::pin(async move {
            WorkspaceTransactionManager::commit(self).await?;
            Ok(())
        })
    }
    fn apply<'e>(
        &'e mut self,
        name: &'e str,
        migration: &'e Migration,
    ) -> BoxFuture<'e, Result<Duration, MigrateError>> {
        Box::pin(async move {
            let name = table(name)?;
            let own_transaction = WorkspaceTransactionManager::get_transaction_depth(self) == 0;
            if own_transaction {
                WorkspaceTransactionManager::begin(self, None).await?;
            }
            let start = Instant::now();
            let result: Result<Duration, MigrateError> = async {
                self.execute_multiple(migration.sql.as_str()).await?;
                let elapsed = start.elapsed();
                sqlx::query::<Workspace>(AssertSqlSafe(format!("INSERT INTO {name} (version, description, success, checksum, execution_time) VALUES (?, ?, 1, ?, ?)")))
                    .bind(migration.version).bind(migration.description.as_ref()).bind(migration.checksum.as_ref())
                    .bind(i64::try_from(elapsed.as_nanos()).unwrap_or(i64::MAX)).execute(&mut *self).await?;
                Ok(elapsed)
            }.await;
            match result {
                Ok(elapsed) => {
                    if own_transaction {
                        WorkspaceTransactionManager::commit(self).await?;
                    }
                    Ok(elapsed)
                }
                Err(error) => {
                    let _ = WorkspaceTransactionManager::rollback(self).await;
                    Err(error)
                }
            }
        })
    }
    fn revert<'e>(
        &'e mut self,
        _: &'e str,
        _: &'e Migration,
    ) -> BoxFuture<'e, Result<Duration, MigrateError>> {
        Box::pin(async {
            Err(sqlx::Error::Protocol("automatic down migrations are disabled".into()).into())
        })
    }
}
