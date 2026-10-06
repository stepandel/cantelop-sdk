import { defineSessionBehaviour } from "@cantelop/sdk/session";
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

export default defineSessionBehaviour<{ title: string }, never, { id: string }>(async context => {
  const db = drizzle(await context.database(), { schema });
  const id = crypto.randomUUID();
  await db.insert(schema.tasks).values({ id, title: context.message.payload.title });
  context.reply({ id });
});
