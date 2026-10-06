# Developer-owned database schema

From this directory, install dependencies and run `cantelop dev`. The compatible
CLI discovers `db/schema.ts`, generates its schema artifact, and automatically
initializes each Workspace before issuing its application connection. No manual
SQL or migration review is needed. `cantelop deploy` applies schema changes before
release activation. The SDK and platform changes must be deployed together.

POST `/tasks` with `{"title":"Review proposal"}`, then GET `/tasks`. Session code
uses the same schema and Workspace database. Drizzle provides the typed queries;
Cantelop provides the renewable libSQL connection and migration lifecycle.

Add a column to `db/schema.ts` to try an automatic local migration. Both API and
Session code import the schema. Existing records survive rebuilds and restarts.

Use `cantelop database migrations WORKSPACE_ID --json` to inspect hosted system
and application migration histories, including the SQL used for application
changes. System records remain unavailable through application SQL.
