import { sqliteTable, text, integer } from "@cantelop/sdk/schema";

// Application tables only. Cantelop owns all cantelop_* objects.
export const tasks = sqliteTable("tasks", {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: "boolean" }).notNull().default(false),
});
