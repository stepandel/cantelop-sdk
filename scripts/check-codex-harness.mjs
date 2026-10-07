import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { createCodex } from "../dist/codex.js";

// Real native harness, mocked model provider. No paid API calls or user credentials.
const executable = resolve(process.argv[2] ?? "native/bin/cantelop-codex");
const directory = await mkdtemp(join(tmpdir(), "cantelop-native-harness-"));
const home = join(directory, "home");
await mkdir(home);
const db = createClient({ url: `file:${join(directory, "test.sqlite")}`, intMode: "bigint" });
db.credentials = async () => ({ url: "libsql://native-fixture.turso.io", authToken: "unused", expiresAt: new Date(Date.now() + 900000).toISOString() });
let modelCalls = 0;
const model = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { request.resume(); response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  assert.equal(typeof JSON.parse(body).model, "string");
  modelCalls++;
  const message = { id: `message-${modelCalls}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native workspace storage verified.", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `response-${modelCalls}` } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Native workspace storage verified." },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: `response-${modelCalls}`, status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise(resolveReady => model.listen(0, "127.0.0.1", resolveReady));
const modelAddress = model.address();
await writeFile(join(home, "config.toml"), `model = "gpt-5.1"\nmodel_provider = "native_fixture"\n[model_providers.native_fixture]\nname = "Native fixture"\nbase_url = "http://127.0.0.1:${modelAddress.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n`);
const options = { executable, database: db, cwd: directory, requestTimeoutMs: 60_000, env: { CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1", OPENAI_API_KEY: undefined } };
let client;
try {
  client = await createCodex(options);
  const thread = await client.startThread({ cwd: directory, approvalPolicy: "never" });
  for await (const event of thread.run("Reply with the storage verification message.")) assert.ok(event.method);
  await client.close(); client = undefined;
  const stored = await db.execute({ sql: "SELECT id FROM cantelop_codex_state_threads WHERE id = ?", args: [thread.id] });
  assert.equal(stored.rows.length, 1);
  client = await createCodex(options);
  const resumed = await client.resumeThread(thread.id, { cwd: directory, approvalPolicy: "never" });
  for await (const event of resumed.run("Repeat the verification message.")) assert.ok(event.method);
  await client.close(); client = undefined;
  assert.equal(modelCalls, 2);
  client = await createCodex(options);
  const admitted = client.startThread({ cwd: directory, approvalPolicy: "never" });
  const closing = client.close();
  const outcomes = await Promise.allSettled([admitted, closing]);
  assert.equal(outcomes[1].status, "fulfilled", "shutdown must drain or reject already-admitted startup requests");
  client = undefined;
  const tables = (await db.execute("SELECT name FROM sqlite_schema WHERE type='table'")).rows.map(row => row.name);
  assert.ok(tables.includes("cantelop_codex_state_threads"));
  assert.ok(tables.includes("cantelop_codex_goals_thread_goals"));
  assert.ok(tables.includes("cantelop_codex_queue_queued_items"));
  const files = await readdir(home, { recursive: true });
  assert.equal(files.some(file => /\.sqlite(?:-|$)/.test(file)), false, "native harness must never create local SQLite files");
  console.log("Real Codex harness: startup, mocked turn, durable workspace metadata, restart, resume, concurrent shutdown and no local SQLite files verified");
} finally {
  await client?.close().catch(() => undefined);
  model.closeAllConnections(); await new Promise(resolveClosed => model.close(resolveClosed));
  db.close(); await rm(directory, { recursive: true, force: true });
}
