# Workspace database integration

`src/client.ts` defines an ordinary backend task service using `app.workspace({ id | slug }).database()`. `src/session.ts` uses the same Workspace database from the native Session runtime. `db/schema.ts` declares the managed application schema.

```ts
const tasks = taskService(connection, { slug: "customer-123" });
await tasks.create("Review proposal");
const list = await tasks.list();
const reply = await tasks.session().request({ title: "Agent task" });
```

The runtime-only manifest requires CLI build protocol 6 and manifest schema 3. The SDK runtime artifact carries the database schema directly, without an API module. Platform/CLI adoption of this prerelease remains a follow-up; do not deploy it with the existing CLI.
