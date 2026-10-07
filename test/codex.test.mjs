import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createCodex, createCodexWorkspaceStorage, CodexError } from "../dist/codex.js";
import { startCodexWorkspaceStorage } from "../dist/codex-storage.js";

function database() {
  // Local SQLite is test infrastructure only; production uses the WorkspaceDatabase client.
  const directory = mkdtempSync(join(tmpdir(), "cantelop-codex-database-"));
  const db = createClient({ url: `file:${join(directory, "fixture.sqlite")}`, intMode: "bigint" });
  const close = db.close.bind(db);
  db.close = () => { close(); rmSync(directory, { recursive: true, force: true }); };
  db.credentials = async () => ({ url: "libsql://fixture.turso.io", authToken: "unused", expiresAt: new Date(Date.now() + 900000).toISOString() });
  return db;
}
const executable = { command: process.execPath, args: [new URL("./fixtures/codex-app-server.mjs", import.meta.url).pathname] };
async function client(t, mode = "success", env = {}) {
  const db = database();
  t.after(() => db.close());
  const codex = await createCodex({ executable, database: db, env: { CODEX_FIXTURE_MODE: mode, ...env } });
  t.after(() => codex.close().catch(() => undefined));
  return { codex, db };
}

test("database bridge preserves signed 64-bit integers, blobs and SQL values", async t => {
  const db = database(); t.after(() => db.close());
  const storage = createCodexWorkspaceStorage(db); t.after(() => storage.close());
  const result = await storage.handle({ operation: "execute", statement: {
    sql: "SELECT ? AS large, ? AS bytes, ? AS empty, ? AS floating, ? AS nullable",
    args: [{ type: "integer", value: "9223372036854775807" }, { type: "blob", base64: "AP8=" }, { type: "text", value: "" }, { type: "float", value: 1.25 }, { type: "null" }],
  } });
  assert.deepEqual(result.rows[0], [
    { type: "integer", value: "9223372036854775807" }, { type: "blob", base64: "AP8=" }, { type: "text", value: "" }, { type: "float", value: 1.25 }, { type: "null" },
  ]);
  assert.deepEqual(result.columns, ["large", "bytes", "empty", "floating", "nullable"]);
});

test("transactions commit atomically; shutdown rolls back abandoned transactions", async t => {
  const db = database(); t.after(() => db.close());
  const storage = createCodexWorkspaceStorage(db);
  await storage.handle({ operation: "execute", statement: { sql: "CREATE TABLE sample (value TEXT)" } });
  const { transactionId } = await storage.handle({ operation: "begin" });
  await storage.handle({ operation: "batch", transactionId, statements: [
    { sql: "INSERT INTO sample VALUES ('first')" }, { sql: "INSERT INTO sample VALUES ('second')" },
  ] });
  await storage.handle({ operation: "commit", transactionId });
  const pending = await storage.handle({ operation: "begin" });
  await storage.handle({ operation: "execute", ...pending, statement: { sql: "INSERT INTO sample VALUES ('abandoned')" } });
  await storage.close();
  assert.deepEqual((await db.execute("SELECT value FROM sample")).rows.map(r => r.value), ["first", "second"]);
  await assert.rejects(storage.handle({ operation: "execute", statement: { sql: "SELECT 1" } }), /storage_closed/);
  assert.equal(db.closed, false, "borrowed DB stays open");
});

test("ambiguous writes are not replayed and SQL/credentials are not leaked", async () => {
  let writes = 0;
  const storage = createCodexWorkspaceStorage({ execute: async () => { writes++; throw new Error("secret SQL and token"); } });
  await assert.rejects(storage.handle({ operation: "execute", statement: { sql: "INSERT INTO sample VALUES (1)" } }), error => {
    assert.equal(error.code, "database_operation_failed"); assert.doesNotMatch(error.message, /secret|token|SQL/); return true;
  });
  assert.equal(writes, 1); await storage.close();
});

test("malformed database requests are rejected before SQL execution", async () => {
  let calls = 0;
  const storage = createCodexWorkspaceStorage({ execute() { calls++; } });
  for (const params of [null, { operation: "unknown" }, { operation: "execute", statement: { sql: "SELECT ?", args: [{ type: "integer", value: "9223372036854775808" }] } },
    { operation: "execute", statement: { sql: "SELECT ?", args: [{ type: "blob", base64: "!" }] } }, { operation: "batch", statements: [] }]) {
    await assert.rejects(storage.handle(params), /invalid_request/);
  }
  assert.equal(calls, 0); await storage.close();
});

test("loopback bridge requires its private bearer token", async t => {
  const db = database(); t.after(() => db.close());
  const bridge = await startCodexWorkspaceStorage(db); t.after(() => bridge.close());
  assert.equal((await fetch(bridge.url, { method: "POST", body: "{}" })).status, 403);
  const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ operation: "execute", statement: { sql: "SELECT 1" } }) });
  assert.equal(response.status, 200);
});

test("stock and partial builds fail preflight without starting app-server or opening the DB", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cantelop-codex-preflight-")); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ["stock", "partial"]) {
    let credentials = 0;
    const started = join(dir, mode);
    await assert.rejects(createCodex({ executable, database: { credentials() { credentials++; } },
      env: { CODEX_FIXTURE_MODE: mode, CODEX_FIXTURE_STARTED: started },
    }), error => error instanceof CodexError && /workspace_backend/.test(error.code));
    assert.equal(credentials, 0);
    await assert.rejects(access(started));
  }
});

test("streams early events and resumes the same thread in a replacement process", async t => {
  const { codex, db } = await client(t);
  const thread = await codex.startThread();
  const events = [];
  for await (const event of thread.run("Inspect the workspace")) events.push(event);
  assert.deepEqual(events.map(e => e.method), ["turn/started", "item/agentMessage/delta", "turn/completed"]);
  await codex.close();
  const replacement = await createCodex({ executable, database: db }); t.after(() => replacement.close());
  const resumed = await replacement.resumeThread(thread.id);
  assert.equal(resumed.id, thread.id);
  assert.equal((await db.execute({ sql: "SELECT prompt FROM codex_fixture_threads WHERE id = ?", args: [thread.id] })).rows[0].prompt, "Inspect the workspace");
});

test("abandoning the iterator interrupts the native turn with its ID", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cantelop-codex-cancel-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const interrupted = join(dir, "interrupted");
  const { codex } = await client(t, "wait", { CODEX_FIXTURE_INTERRUPTED: interrupted });
  const thread = await codex.startThread();
  for await (const event of thread.run("Work")) { assert.equal(event.method, "turn/started"); break; }
  assert.equal(await readFile(interrupted, "utf8"), "turn-1");
});

test("abort interrupts native work even while the generator is suspended at a yield", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cantelop-codex-abort-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const interrupted = join(dir, "interrupted");
  const { codex } = await client(t, "wait", { CODEX_FIXTURE_INTERRUPTED: interrupted });
  const thread = await codex.startThread();
  const controller = new AbortController();
  const events = thread.run("Work", { signal: controller.signal });
  await events.next(); controller.abort(new Error("cancelled"));
  for (let i = 0; i < 100; i++) { if (await access(interrupted).then(() => true, () => false)) break; await delay(10); }
  assert.equal(await readFile(interrupted, "utf8"), "turn-1");
  await assert.rejects(events.next(), /cancelled/);
});

test("native failure and transport loss do not masquerade as a successful turn", async t => {
  for (const mode of ["failed-turn", "disconnect"]) {
    const { codex } = await client(t, mode);
    const thread = await codex.startThread();
    await assert.rejects(async () => { for await (const event of thread.run("Work")) {} }, /turn_failed|transport_closed/);
  }
});

test("request timeout never retries; native errors are sanitized", async t => {
  const { codex } = await client(t);
  await assert.rejects(codex.request("test/no-reply", {}, { timeoutMs: 30 }), /request_timeout/);
  await assert.rejects(codex.request("unsupported"), error => {
    assert.doesNotMatch(error.message, /secret|token/); assert.match(error.message, /-32601/); return true;
  });
});

test("unknown native approval requests are rejected, not auto-approved", async t => {
  const { codex } = await client(t);
  const response = new Promise(resolve => {
    const unsubscribe = codex.onNotification(event => { if (event.method === "test/server-response") { unsubscribe(); resolve(event.params.response); } });
  });
  await codex.request("test/server-request");
  assert.equal((await response).error.code, -32000);
});

test("storage close reports a failed rollback and still releases the transaction", async () => {
  const transaction = { closed: false, rollback: async () => { throw new Error("secret rollback detail"); }, close() { this.closed = true; } };
  const storage = createCodexWorkspaceStorage({ transaction: async () => transaction });
  await storage.handle({ operation: "begin" });
  await assert.rejects(storage.close(), error => {
    assert.equal(error.code, "database_operation_failed");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(transaction.closed, true);
});
