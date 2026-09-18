import { defineApi, type D1Database, type D1Result } from "../dist/api.js";
import { defineSessionBehaviour } from "../dist/session.js";

defineApi<{ prompt: string }>(({ env, db, router }) => {
  const setting: string | undefined = env.SETTING;
  router.route("GET", "/", async () => {
    if (!db) return new Response(setting, { status: 503 });
    const native: D1Database = db;
    const result: D1Result<{ id: number }> = await native.prepare("SELECT ? AS id").bind(1).all<{ id: number }>();
    await native.batch([native.prepare("SELECT 1")]);
    await native.withSession("first-primary").prepare("SELECT 1").first();
    return Response.json(result.results);
  });
});
defineSessionBehaviour(async () => {});
// Importing the API must not introduce Cloudflare-only ambient globals.
// @ts-expect-error Worker globals must remain scoped to their module.
const leaked: DurableObjectNamespace = undefined;
