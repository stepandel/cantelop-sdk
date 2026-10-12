import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Use the real generated HTTP client. Only replace the server process and HTTP
// transport; the adapter calls stock session.create/prompt/abort operations.
async function fixture() {
  const key = `opencode-test-${crypto.randomUUID()}`;
  const controller = new AbortController();
  let starts = 0, closes = 0, creates = 0, aborts = 0;
  const prompts = [];
  let finish;
  const nativeResponse = text => ({
    info: { id: "message", role: "assistant", sessionID: "ses_test" },
    parts: [{ id: "part", messageID: "message", sessionID: "ses_test", type: "text", text }],
  });
  globalThis[key] = {
    async server(options) {
      starts++;
      options.signal.addEventListener("abort", () => { closes++; }, { once: true });
      return { url: "http://opencode.test", close() { closes++; } };
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/session") { creates++; return Response.json({ id: "ses_test" }); }
      if (url.pathname.endsWith("/abort")) { aborts++; return Response.json(true); }
      if (url.pathname.endsWith("/message")) {
        const body = await request.json();
        const prompt = body.parts[0].text;
        prompts.push(prompt);
        if (prompt === "hold") return new Promise(resolve => { finish = () => resolve(Response.json(nativeResponse("interrupted"))); });
        if (prompt === "error") return Response.json({ ...nativeResponse(""), info: { error: { name: "ProviderError", data: { message: "native failure" } } } });
        return Response.json(nativeResponse(prompt));
      }
      throw new Error(`Unexpected stock API request: ${request.method} ${url.pathname}`);
    },
  };
  const clientPath = new URL("../examples/opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js", import.meta.url).pathname;
  const bundle = await build({
    entryPoints: [new URL("../examples/opencode/src/agent.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "stock-opencode-fixture", setup(builder) {
      builder.onResolve({ filter: /^@opencode-ai\/sdk\/v2\/(client|server)$/ }, ({ path }) => ({ path, namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path.endsWith("server")
          ? `export const createOpencodeServer = globalThis[${JSON.stringify(key)}].server;`
          : `import {createOpencodeClient as create} from ${JSON.stringify(clientPath)}; export const createOpencodeClient = options => create({...options, fetch: globalThis[${JSON.stringify(key)}].fetch});`,
        resolveDir: process.cwd(),
      }));
    } }],
  });
  const adapter = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const harness = await adapter.create({ signal: controller.signal, session: { id: "test" }, env: {} });
  const events = [];
  return {
    events, prompts,
    run: (prompt, signal = new AbortController().signal) => harness.run({ type: "prompt", prompt }, { signal, output: { send: async event => events.push(event) } }),
    cancel: () => harness.cancel(),
    finish: () => finish(),
    counts: () => ({ starts, closes, creates, aborts }),
    close() { controller.abort(); delete globalThis[key]; },
  };
}

test("OpenCode wraps one stock server/session and forwards native responses across turns", async () => {
  const f = await fixture();
  try {
    await f.run("one"); await f.run("two");
    assert.deepEqual(f.prompts, ["one", "two"]);
    assert.deepEqual(f.events.map(event => event.parts[0].text), ["one", "two"]);
    assert.deepEqual(f.counts(), { starts: 1, closes: 0, creates: 1, aborts: 0 });
  } finally { f.close(); }
  assert.equal(f.counts().closes, 1);
});

test("OpenCode cancellation calls native abort and waits for the native prompt boundary", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const work = f.run("hold", controller.signal);
    let settled = false;
    const outcome = work.then(() => { settled = true; }, error => { settled = true; return error; });
    while (!f.prompts.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await f.cancel();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.counts().aborts, 1);
    assert.equal(f.counts().closes, 0);
    f.finish();
    assert.equal((await outcome).name, "AbortError");
    assert.deepEqual(f.events, []);
    await f.run("next");
    assert.equal(f.events[0].parts[0].text, "next");
    assert.equal(f.counts().creates, 1);
  } finally { f.close(); }
});

test("OpenCode propagates provider failure instead of reporting a successful result", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run("error"), /native failure/);
    assert.deepEqual(f.events, []);
  } finally { f.close(); }
});
