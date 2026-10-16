import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodexTestDatabase } from "./codex-test-database.mjs";
import { createCodex } from "../dist/codex.js";
import { createCodexRuntime, NativeCodex } from "../dist/harnesses/codex.js";

// Real native harness, mocked model provider. No paid API calls or user credentials.
const selectedExecutable = process.argv[2] ?? process.env.CANTELOP_CODEX_PATH;
if (!selectedExecutable) throw new Error("Pass a native executable path or set CANTELOP_CODEX_PATH; see docs/codex.md");
const executable = resolve(selectedExecutable);
const directory = await mkdtemp(join(tmpdir(), "cantelop-native-harness-"));
const home = join(directory, ".codex");
await mkdir(home);
const db = createCodexTestDatabase(`file:${join(directory, "test.sqlite")}`);
db.credentials = async () => ({ url: "libsql://native-fixture.turso.io", authToken: "unused", expiresAt: new Date(Date.now() + 900000).toISOString() });
let modelCalls = 0;
const models = [];
const modelTools = [];
const model = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { request.resume(); response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  assert.equal(typeof input.model, "string");
  models.push(input.model);
  const names = tools => tools.flatMap(tool => [tool.name, ...(tool.tools ? names(tool.tools) : [])]).filter(Boolean);
  modelTools.push(names(input.tools ?? []));
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
await writeFile(join(home, "config.toml"), `model = "gpt-5.1"\nmodel_provider = "native_fixture"\nsandbox_mode = "danger-full-access"\n[model_providers.native_fixture]\nname = "Native fixture"\nbase_url = "http://127.0.0.1:${modelAddress.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n`);
const options = { executable, database: db, cwd: directory, requestTimeoutMs: 60_000, env: { CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1", OPENAI_API_KEY: undefined } };
let client;
try {
  console.log("Verifying native turn and persistence");
  client = await createCodex(options);
  const command = await client.request("command/exec", { command: ["/usr/bin/printf", "native-tool-ok"], cwd: directory });
  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout, "native-tool-ok");
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
  console.log("Verifying native concurrent shutdown");
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
  // Exercise the packaged runtime with the same real executable and mocked provider.
  console.log("Verifying packaged durable runtime and task settings");
  // No Session platform or model credentials are required by this qualification test.
  const connect = native => createCodex({ ...options, ...native, executable, database: db, env: { ...native.env, ...options.env } });
  const factory = (context, settings) => {
    const native = new NativeCodex({ ...settings, sessionId: context.session.id }, context.signal, connect);
    return { async queue(message, work) {
      try { await native.queue(message, work); }
      catch (error) { console.error("Native qualification task failed", error); throw error; }
    }, steer: native.steer.bind(native), cancel: native.cancel.bind(native) };
  };
  let busy = false, mailbox = Promise.resolve(), reply;
  const lifetime = new AbortController();
  let runtime;
  const context = { signal: lifetime.signal, session: { id: "durable-native-smoke" }, env: {}, database: async () => db,
    output: { send: async () => { throw new Error("Observer disconnected"); } }, view: { commit: async () => {} },
    send: async command => { void send(command); },
    activity: { get active() { return busy; }, extend() {}, start(work) {
      busy = true; const pending = [];
      void work({ signal: lifetime.signal, output: context.output, view: context.view, send: command => pending.push(command) })
        .then(() => { busy = false; for (const command of pending) void send(command); })
        .catch(error => { busy = false; console.error(error); });
    } },
  };
  function send(payload) {
    return mailbox = mailbox.then(() => runtime.receive({ ...context, command: { type: "dispatch" }, message: { id: payload.id ?? "internal", sequence: 1, payload }, reply: value => { reply = value; } }));
  }
  async function completed() {
    const deadline = Date.now() + 60_000;
    for (;;) {
      await send({ type: "snapshot" });
      if (!busy && reply.messages.at(-1)?.status === "completed") return reply;
      if (!busy && reply.messages.at(-1)?.status === "failed") throw new Error("Real durable Codex turn failed");
      if (Date.now() > deadline) throw new Error("Real durable Codex turn timed out");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  runtime = createCodexRuntime({ workspace: directory, approvalPolicy: "never" }, factory);
  await runtime.onActivate(context);
  const prompt = { type: "queue", id: "request-one", text: "Verify durable runtime.", settings: { model: "gpt-5.1-codex" } };
  await send(prompt);
  const before = await completed();
  runtime = createCodexRuntime({ workspace: directory, approvalPolicy: "never" }, factory);
  await runtime.onActivate(context);
  await send(prompt); // Redelivery must not execute another native turn.
  await send({ type: "queue", id: "request-two", text: "Continue the durable conversation." });
  const after = await completed();
  assert.equal(before.threadId, after.threadId);
  assert.equal(modelCalls, 4);
  assert.deepEqual(models.slice(-2), ["gpt-5.1-codex", "gpt-5.1"]);
  for (const names of modelTools.slice(-2)) {
    assert.ok(names.length, "Native tools must remain available");
    assert.equal(names.some(name => /^(create_goal|get_goal|update_goal|spawn_agent)$/.test(name)), false, "Unowned native goals and agents must be disabled");
  }
  await send({ type: "events", after: 0, limit: 100 });
  assert.ok(reply.events.some(event => event.type === "message.status" && event.status === "completed"));
  assert.ok(reply.events.some(event => event.type === "codex"));
  assert.equal((await readdir(home, { recursive: true })).some(file => /\.sqlite(?:-|$)/.test(file)), false);
  lifetime.abort();
  console.log("Real Codex: native storage, restart/resume, concurrent shutdown, durable runtime, input deduplication and observer-independent event replay verified");
} finally {
  await client?.close().catch(() => undefined);
  model.closeAllConnections(); await new Promise(resolveClosed => model.close(resolveClosed));
  db.close(); await rm(directory, { recursive: true, force: true });
}
