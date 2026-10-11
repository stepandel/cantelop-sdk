# Workspace database integration

The application backend and a Session use the same managed Workspace database. The backend calls ordinary task functions directly; the Session calls those same functions when it receives a message.

- `src/cantelop.ts` defines the named App and its runtime.
- `src/backend.ts` is a runnable Node application that creates a task directly, requests another task from a Session, and lists both from the same database.
- `src/runtime.ts` implements the Session handler.
- `src/tasks.ts` contains shared database functions.
- `db/schema.ts` declares the managed application schema.

The backend integration is:

```ts
import { app } from "./cantelop.js";
import { createTask, listTasks } from "./tasks.js";

const workspace = app.workspace({ slug: "customer-123" });
const database = await workspace.database();
try {
  await createTask(database, "Review proposal");
  const session = workspace.session();
  const reply = await session.request({ title: "Agent task" });
  const tasks = await listTasks(database);
} finally {
  database.close();
}
```

Any HTTP routes or webhook handlers belong in the customer's application. Cantelop generates the protocol Edge Worker; this example defines no Edge routes.

## Build and run

From the repository root, build the SDK and then the example:

```sh
pnpm build
pnpm --filter @cantelop/example-database build
```

`build.mjs` applies the Cantelop compiler to the backend bundle. It extracts the runtime from the App definition, so the backend uses a compiled App handle while the Session handler runs in the Sandbox.

Once a compatible CLI/platform has deployed the App, applied its managed schema, and provisioned App-scoped integration credentials, run:

```sh
pnpm --filter @cantelop/example-database start customer-123
```

The program prints the backend-created task, Session reply, and stored tasks. Repeated runs create more tasks. Database registration is asynchronous; `database_not_ready` means provisioning has not completed. The backend closes its database client on completion.

`cantelop.json` selects `src/cantelop.ts` for deployment. The runtime artifact carries the database schema directly. This prerelease requires CLI build protocol 6 and manifest schema 3; CLI/platform adoption remains a follow-up.
