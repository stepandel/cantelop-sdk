import type { SessionContext } from "@cantelop/sdk/session";
import type { TaskMessage, TaskReply } from "./contracts.js";
type Context = SessionContext<TaskMessage, never, TaskReply>;
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

export async function receive(context: Context): Promise<void> {
  const db = drizzle(await context.database(), { schema });
  const id = crypto.randomUUID();
  await db.insert(schema.tasks).values({ id, title: context.message.payload.title });
  context.reply({ id });
}
