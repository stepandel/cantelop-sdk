# App databases

An enabled App database is available as `db` in the Edge API context. It is the
native D1 handle: prepared statements, bound parameters, batches, sessions,
and compatible ORMs work directly. No Cloudflare credentials are needed in
application code. `env` continues to contain only string variables and secrets.

```ts
import { defineApi } from "@cantelop/sdk/api";

export default defineApi(({ db, router }) => {
  router.route("GET", "/items", async () => {
    if (!db) return Response.json({ error: "database_unavailable" }, { status: 503 });
    const result = await db.prepare("SELECT id, title FROM items LIMIT ?")
      .bind(100).all<{ id: number; title: string }>();
    return Response.json(result.results);
  });
});
```

With Drizzle, import `drizzle` from `drizzle-orm/d1` and use `drizzle(db)` inside
the handler after checking that `db` is defined. D1 types are exported from
`@cantelop/sdk/api`; importing them does not install Worker-only ambient globals
into Session/Node projects.

Add `"database": { "migrations": "migrations" }` to `cantelop.json`. Create
`migrations/0001_items.sql`:

```sql
CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
INSERT INTO items (title) VALUES ('First item');
```

Run `cantelop database migrate --local` before `cantelop dev`. The CLI keeps local
D1 data under `.cantelop/dev/database`, including through API reloads. Stop the
development server before applying further local migrations. Deployment enables
the App database but never implicitly runs migrations. Run
`cantelop app database migrate APP_ID migrations` explicitly for deployed data.

Migration files are ordered by filename and checked by SHA-256. A retry verifies
the ledger and skips a matching applied file; changing an applied migration or
inserting an older migration fails. A file and its ledger entry execute in one
D1 batch. Files are limited to 90 KB; explicit transaction and trigger blocks are
not supported by the initial runner. The words BEGIN, COMMIT, ROLLBACK,
SAVEPOINT, RELEASE, and the internal ledger name are reserved even in comments
and strings. Use additive schema changes across code deployments.

The database is shared by all Workspaces within an App; the application must
scope and authorize its own rows. Session runtimes do not receive `db`. Create
prepared statements and D1 sessions in request handlers rather than sharing
mutable sessions between requests. D1 sessions concern database consistency and
are separate from Cantelop Sessions.

The existing artifact schema and build protocol are unchanged. Local database
support adds CLI-only `serveLocalDatabaseApi` and `migrateLocalDatabase` exports
from `@cantelop/sdk/build`; these use the Miniflare version pinned by the platform
Wrangler toolchain. They do not execute as part of deployed API Workers.
