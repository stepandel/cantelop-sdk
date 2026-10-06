import { defineApi } from "@cantelop/sdk/api";
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

export default defineApi(({ app, router }) => {
  router.route("GET", "/tasks", async () => {
    const workspace = await app.workspaces.open({ slug: "default" });
    const db = drizzle(await workspace.database(), { schema });
    return Response.json(await db.query.tasks.findMany());
  });
  router.route("POST", "/tasks", async ({ request }) => {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("title" in body) || typeof body.title !== "string") {
      return Response.json({ error: "title is required" }, { status: 400 });
    }
    const workspace = await app.workspaces.open({ slug: "default" });
    const db = drizzle(await workspace.database(), { schema });
    const task = { id: crypto.randomUUID(), title: body.title };
    await db.insert(schema.tasks).values(task);
    return Response.json(task, { status: 201 });
  });
});
