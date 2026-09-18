import { defineApi } from "../dist/api.js";
import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
const items = sqliteTable("items", { id: integer().primaryKey(), title: text().notNull() });
defineApi(({ db, router }) => {
  router.route("GET", "/", async () => {
    if (!db) return new Response(null, { status: 503 });
    return Response.json(await drizzle(db).select().from(items).all());
  });
});
