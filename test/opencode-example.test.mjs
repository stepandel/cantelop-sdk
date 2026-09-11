import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Keep the real generated HTTP/SSE client; replace only process creation and
// network transport so lifecycle regressions do not require provider credentials.
async function fixture(mode = "success") {
  const key = `opencode-test-${crypto.randomUUID()}`;
  let controller;
  let closed = 0;
  let subscribed = false;
  let aborted = 0;
  const prompts = [];
  const emit = (event) => controller.enqueue(new TextEncoder().encode(
    `data: ${JSON.stringify(event)}\n\n`,
  ));
  globalThis[key] = {
    server: async () => ({ url: "http://opencode.test", close() { closed++; } }),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/session" && request.method === "POST") {
        return Response.json({ id: "ses_test" });
      }
      if (url.pathname === "/event") {
        subscribed = true;
        return new Response(new ReadableStream({
          start(c) {
            controller = c;
            emit({ type: "server.connected", properties: {} });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/abort")) {
        aborted++;
        return Response.json(true);
      }
      if (url.pathname.endsWith("/prompt_async")) {
        assert.equal(subscribed, true, "subscribe before submitting a prompt");
        prompts.push((await request.json()).parts[0].text);
        if (mode === "disconnect") controller.close();
        if (mode === "success") {
          emit({ type: "message.updated", properties: { info: {
            id: "msg_answer", role: "assistant", sessionID: "ses_test",
          } } });
          emit({ type: "message.part.updated", properties: { part: {
            id: "part_text", messageID: "msg_answer", sessionID: "ses_test", type: "text", text: "",
          } } });
          emit({ type: "message.part.delta", properties: {
            partID: "part_text", messageID: "msg_answer", sessionID: "ses_other", field: "text", delta: "wrong",
          } });
          emit({ type: "message.part.delta", properties: {
            partID: "part_text", messageID: "msg_answer", sessionID: "ses_test", field: "text", delta: "Hello",
          } });
          // Final snapshot must not duplicate the delta already delivered.
          emit({ type: "message.part.updated", properties: { part: {
            id: "part_text", messageID: "msg_answer", sessionID: "ses_test", type: "text", text: "Hello",
          } } });
          emit({ type: "session.idle", properties: { sessionID: "ses_test" } });
        }
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    },
  };
  const clientPath = new URL("../examples/opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js", import.meta.url).pathname;
  const result = await build({
    entryPoints: [new URL("../examples/opencode/src/session.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "opencode-fixture", setup(builder) {
      builder.onResolve({ filter: /^@opencode-ai\/sdk\/v2\/(client|server)$/ }, ({ path }) => ({ path, namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path.endsWith("server")
          ? `export const createOpencodeServer = globalThis[${JSON.stringify(key)}].server;`
          : `import {createOpencodeClient as create} from ${JSON.stringify(clientPath)}; export const createOpencodeClient = options => create({...options, fetch: globalThis[${JSON.stringify(key)}].fetch});`,
        resolveDir: process.cwd(),
      }));
    } }],
  });
  const { default: behaviour } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  let work;
  let active = false;
  const abort = new AbortController();
  const events = [];
  const followups = [];
  const activity = {
    get active() { return active; },
    start(fn) { active = true; work = fn({ signal: abort.signal, output: { send: async e => events.push(e) }, send: e => followups.push(e) }).finally(() => { active = false; }); },
    cancel() { abort.abort(); },
  };
  const receive = payload => behaviour.receive({
    message: { payload }, session: { id: "cantelop-test" },
    env: { ANTHROPIC_API_KEY: "test-placeholder" }, activity,
  });
  return { receive, events, followups, prompts, emit, get work() { return work; },
    get closed() { return closed; }, get aborted() { return aborted; },
    cleanup() { delete globalThis[key]; },
  };
}

test("OpenCode subscribes before prompting and filters/deduplicates text", { timeout: 5_000 }, async () => {
  const f = await fixture();
  try {
    f.receive({ type: "prompt", prompt: "hello" });
    await f.work;
    assert.deepEqual(f.events, [{ type: "text_delta", delta: "Hello" }, { type: "done", answer: "Hello" }]);
    assert.equal(f.closed, 1);
    assert.equal(f.aborted, 1);
  } finally { f.cleanup(); }
});

test("OpenCode cancellation clears queued steering and stops the server", { timeout: 5_000 }, async () => {
  const f = await fixture("waiting");
  try {
    f.receive({ type: "prompt", prompt: "hello" });
    f.receive({ type: "steer", prompt: "follow-up" });
    while (!f.prompts.length) await new Promise(resolve => setImmediate(resolve));
    f.receive({ type: "cancel" });
    await f.work;
    assert.deepEqual(f.followups, []);
    assert.deepEqual(f.events, []);
    assert.equal(f.aborted, 1);
    assert.equal(f.closed, 1);
  } finally { f.cleanup(); }
});

test("OpenCode queues a busy-time steer for the next activity", { timeout: 5_000 }, async () => {
  const f = await fixture();
  try {
    f.receive({ type: "prompt", prompt: "hello" });
    f.receive({ type: "steer", prompt: "next" });
    await f.work;
    assert.deepEqual(f.followups, [{ type: "prompt", prompt: "next" }]);
  } finally { f.cleanup(); }
});

test("OpenCode stream loss emits an error instead of a false completion", { timeout: 5_000 }, async () => {
  const f = await fixture("disconnect");
  try {
    f.receive({ type: "prompt", prompt: "hello" });
    await f.work;
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].type, "error");
    assert.equal(f.closed, 1);
    assert.equal(f.aborted, 1);
  } finally { f.cleanup(); }
});


test("OpenCode preserves a new prompt received after cancel during cleanup", { timeout: 5_000 }, async () => {
  const f = await fixture("waiting");
  try {
    f.receive({ type: "prompt", prompt: "hello" });
    while (!f.prompts.length) await new Promise(resolve => setImmediate(resolve));
    f.receive({ type: "cancel" });
    f.receive({ type: "prompt", prompt: "new work" });
    await f.work;
    assert.deepEqual(f.followups, [{ type: "prompt", prompt: "new work" }]);
    assert.equal(f.closed, 1);
  } finally { f.cleanup(); }
});
