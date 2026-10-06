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
interactive `transaction`. Application code owns its schema definitions. Compatible CLI/platform versions
automatically generate and apply application migrations from `db/schema.ts`.
Hosted application tokens allow data operations on application tables only;
schema changes run through the migration lifecycle. Both surfaces connect directly to the Workspace database.

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

Application connections exclude `cantelop_*` system tables. Table naming is not a security
boundary between Sessions. Archived Workspaces cannot issue new credentials;
already issued credentials remain valid until expiry.

## Local development

With a compatible CLI and SDK, `cantelop dev` implements these same database
interfaces using disposable SQLite files under `.cantelop/dev/databases/`.
The API and all Sessions in a Workspace share one database, in native and
container mode. Data survives rebuilds and runner restarts. Stop the runner and
remove that directory to reset local databases; Workspace files are retained.
Local data is never synchronized with hosted databases, and no login or Turso
credentials are needed.

The CLI supplies an explicit local database origin and Session credential broker.
Application code does not set these options or environment values. Ordinary
hosted clients continue accepting only hosted Turso credentials. The SDK build
module advertises `CANTELOP_LOCAL_DATABASE_PROTOCOL_VERSION = 1`; older SDKs
must be upgraded before running a database-enabled CLI's development command.
Local native libSQL clients can use the returned HTTP URL and bearer token.

Local SQL tokens last 15 minutes and become invalid when the runner stops.
Stopping a Session blocks credential renewal. Abandoned HTTP streams, including
open transactions, are rolled back after one minute of inactivity; keep
transactions short. Local development covers SQL behavior and sharing, while
hosted provisioning, distributed infrastructure, and archive/purge lifecycle
still require deployed testing.

## Developer schema and automatic migrations

Define application tables in `db/schema.ts` using Drizzle's SQLite definitions:

```ts
import { sqliteTable, text, integer } from "@cantelop/sdk/schema";
export const tasks = sqliteTable("tasks", {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: "boolean" }).notNull().default(false),
});
```

Use Drizzle directly with the renewable Workspace client:

```ts
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";
const db = drizzle(await context.database(), { schema });
await db.insert(schema.tasks).values({ id: "task-1", title: "Review proposal" });
const tasks = await db.query.tasks.findMany();
```

The CLI runs builds from the project root and discovers `db/schema.ts`. Restart
`cantelop dev` if you add that file to a project that did not have it at startup. A build
contains a deterministic schema snapshot, with no system tables, in a version 4
API manifest. Projects without this file retain their version 3 manifest. The
schema file is evaluated in a bounded build subprocess, never in the platform.
Generated SQL is retained in the Workspace migration history; generated migration
files do not need to be reviewed or committed. `cantelop dev` applies changes
before a Workspace is first used and after schema rebuilds. `cantelop deploy`
applies changes to existing ready Workspaces before release activation. New
Workspaces apply the active release's schema when their first application
connection opens.

Additions run automatically. Changes to an existing column or removing tables
or columns require `export const allowDestructiveChanges = true` in the schema
file. This is an explicit code declaration, not an interactive approval. Hosted
activation closes admission before such changes; a failure leaves admission
closed for a corrective deployment. Ambiguous table/column renames are rejected
rather than prompting or guessing. Custom data transformations and rename maps
are not supported in this initial protocol. Views are also excluded initially.
Local destructive changes are intended for disposable development databases.

A write transaction serializes migration execution and commits schema changes
with their history record. System and application histories are independent:
`cantelop_system_migrations` records SDK-owned migrations, while
`cantelop_application_migrations` records application schema digests, snapshots,
SQL, and timestamps. Re-activating an already-applied historical schema retains
the newer database structure; it never automatically down-migrates. After an
explicit destructive change, older application releases may no longer be
compatible even though their schema digest appears in history.

Inspect hosted history with:

```sh
cantelop database migrations WORKSPACE_ID
cantelop database migrations WORKSPACE_ID --json
```

Table and index names beginning with `cantelop_`, `sqlite_`, or `__` are reserved,
case-insensitively. Foreign keys must reference another declared application
table. Only application objects participate in migration generation.

## Access boundary and rollout

There is one physical database per Workspace. Hosted application credentials use
Turso's fine-grained permissions, restricted to named application tables and data
operations. Migration credentials additionally permit schema operations on
application tables, Drizzle's temporary rebuild tables, and the application
migration ledger. Before using either grant, the platform verifies that system
reads are denied; a provider that ignores permissions fails closed. SQLite
metadata remains readable; this restriction protects system records.

Local HTTP connections use SQLite's authorizer to deny system access, including
indirect access through triggers and views. The CLI applies migrations through
a separate local file connection. Hosted and local databases require no new
physical database or synchronization between environments.

The hosted SDK mailbox still executes inside the trusted Session process and
requests a privileged internal connection using the runtime capability. That
connection is never returned by `context.database()`. This separates public
application access from internal runtime access; it does not sandbox malicious
code in the same process or hide that process's capability. A stronger boundary
requires moving mailbox operations behind a platform service.

Deploy the updated SDK, CLI, and platform together. Old Session runtimes that use
the application credential path for mailbox SQL are incompatible with the new
application-only grants. Previously issued full-access tokens remain usable
until their expiry (15 minutes). Hosted permission enforcement requires a live
Turso qualification before production rollout; local and mocked tests cannot
verify the hosted service's implementation.
