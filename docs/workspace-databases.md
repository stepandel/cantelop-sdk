# Workspace databases

Cantelop automatically provisions a remote Turso/libSQL database for each
Workspace. The API and Sessions in that Workspace share the same database.
Provisioning is asynchronous; opening the database can report
`database_not_ready` while registration is pending.

## API

```ts
const workspace = await app.workspaces.open({ slug: "default" });
const db = await workspace.database();
await db.execute({
  sql: "INSERT INTO metadata (session_id, value) VALUES (?, ?)",
  args: [sessionId, value],
});
```

The platform authorizes the canonical Workspace against the current App.

## Session

Within `receive` or `onRecover`:

```ts
const db = await context.database();
const result = await db.execute("SELECT * FROM metadata");
```

Before the first message, or from standalone Session code:

```ts
import { createSessionDatabase } from "@cantelop/sdk/session";
const db = createSessionDatabase();
const credentials = await db.credentials(); // url, authToken, expiresAt
```

Native libSQL clients can request credentials directly with the platform-owned
`CANTELOP_WORKSPACE_DATABASE_CREDENTIALS_URL` and bearer
`CANTELOP_WORKSPACE_DATABASE_ACCESS_TOKEN`. Send POST with no Workspace ID.
Renew before `expiresAt`, and do not log either token.

## SQL and connection lifecycle

Clients support parameterized `execute`, atomic `batch`, `executeMultiple`, and
interactive `transaction`. Application code owns table creation and schema
migrations. Both surfaces connect directly to the remote database.

```ts
const tx = await db.transaction("write");
try {
  await tx.execute({ sql: "UPDATE metadata SET value = ? WHERE session_id = ?", args: [value, sessionId] });
  await tx.commit();
} finally {
  tx.close();
}
```

Credential renewal is automatic before operations. A transaction retains its
original connection until commit, rollback, or close. Keep transactions short
and always close them. SQL writes and failed commits are never automatically
replayed; use application-level idempotency to resolve ambiguous outcomes.

Call `db.close()` when a manually owned client is finished. The managed Session
server closes its context client at shutdown. Calling `context.database()` or
`workspace.database()` again after closing their client creates a fresh client.

Access covers the whole Workspace database. Table naming is not a security
boundary between Sessions. Archived Workspaces cannot issue new credentials;
already issued credentials remain valid until expiry.
