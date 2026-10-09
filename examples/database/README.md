# Workspace database integration

`src/cantelop.ts` configures the client and its Session handler. `src/tasks.ts` contains plain database functions shared by the application backend and the runtime. `db/schema.ts` declares the managed application schema.

```ts
import { cantelop } from "./src/cantelop.js";
import { createTask, listTasks } from "./src/tasks.js";

const workspace = cantelop.workspace({ slug: "customer-123" });
await createTask(await workspace.database(), "Review proposal");
const tasks = await listTasks(await workspace.database());

const session = workspace.session({ id: "conversation-456" });
const reply = await session.request({ title: "Agent task" });
```

The receive handler calls `createTask` against its Workspace database and replies with the task ID. Backend calls and runtime messages use the same schema and function.

`cantelop.json` selects `src/cantelop.ts` for deployment. The runtime artifact carries the database schema directly. This prerelease requires CLI build protocol 6 and manifest schema 3; CLI/platform adoption remains a follow-up.
