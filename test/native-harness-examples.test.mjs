import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

async function load(example, provider, exports) {
  const key = `native-harness-${crypto.randomUUID()}`;
  globalThis[key] = exports;
  const bundle = await build({
    entryPoints: [new URL(`../examples/${example}/src/agent.ts`, import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "native-api-fixture", setup(builder) {
      builder.onResolve({ filter: new RegExp(`^${provider}$`) }, () => ({ path: provider, namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: Object.keys(exports).map(name => `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];`).join("\n") }));
    } }],
  });
  try { return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`); }
  finally { delete globalThis[key]; }
}
const codex = await load("codex", "@openai/codex-sdk", { Codex: class {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
const work = (events, signal = new AbortController().signal) => ({ signal, output: { send: async event => events.push(event) } });

test("Codex wrapper delegates to the same native Thread and forwards native tool/turn events", async () => {
  const calls = [], output = [];
  const thread = { async runStreamed(prompt, options) {
    calls.push({ prompt, signal: options.signal });
    return { events: (async function* () {
      yield { type: "thread.started", thread_id: "native-thread" };
      yield { type: "item.completed", item: { type: "command_execution", id: "tool", command: "pwd", status: "completed", aggregated_output: "/workspace" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
    })() };
  } };
  const harness = codex.wrapCodex(thread);
  const context = work(output);
  await harness.run({ prompt: "first" }, context);
  await harness.run({ prompt: "next" }, context);
  assert.deepEqual(calls.map(call => call.prompt), ["first", "next"]);
  assert.equal(calls.every(call => call.signal === context.signal), true);
  assert.equal(output.length, 6);
  assert.equal(output[1].item.command, "pwd");
  assert.equal("steer" in harness, false);
});

test("Codex wrapper passes interruption to the native SDK and propagates turn failure", async () => {
  const controller = new AbortController(), output = [];
  const harness = codex.wrapCodex({ async runStreamed(_, { signal }) {
    assert.equal(signal, controller.signal);
    return { events: (async function* () {
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    })() };
  } });
  const result = assert.rejects(harness.run({ prompt: "hold" }, work(output, controller.signal)), /abort/i);
  await tick(); controller.abort(); await result;
  assert.deepEqual(output, []);
  const failed = codex.wrapCodex({ async runStreamed() {
    return { events: (async function* () { yield { type: "turn.failed", error: { message: "native failure" } }; })() };
  } });
  await assert.rejects(failed.run({ prompt: "fail" }, work(output)), /native failure/);
});

test("Codex wrapper rejects a truncated stream without claiming turn completion", async () => {
  const harness = codex.wrapCodex({ async runStreamed() { return { events: (async function* () {})() }; } });
  await assert.rejects(harness.run({ prompt: "hello" }, work([])), /before turn completion/);
});

function nativeQuery() {
  const messages = [];
  let reader, interrupts = 0, returned = 0;
  return {
    next() {
      if (messages.length) return Promise.resolve({ value: messages.shift(), done: false });
      return new Promise(resolve => { reader = resolve; });
    },
    emit(message) {
      if (reader) { const resolve = reader; reader = undefined; resolve({ value: message, done: false }); }
      else messages.push(message);
    },
    async interrupt() { interrupts++; },
    async return() { returned++; return { done: true }; },
    close() {},
    counts: () => ({ interrupts, returned }),
  };
}
const claude = await load("anthropic", "@anthropic-ai/claude-agent-sdk", { query() {} });
const success = result => ({ type: "result", subtype: "success", is_error: false, result, session_id: "native-session" });

test("Claude wrapper preserves one native Query across turns and forwards native input priority/output", async () => {
  const query = nativeQuery(), prompts = [], output = [];
  const harness = claude.wrapClaude(query, { send: (...args) => prompts.push(args) });
  const first = harness.run({ prompt: "first" }, work(output));
  const event = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }, session_id: "native-session" };
  query.emit(event);
  await harness.steer({ prompt: "adjust" });
  query.emit(success("first answer")); await first;
  const next = harness.run({ prompt: "next" }, work(output));
  query.emit(success("next answer")); await next;
  assert.deepEqual(prompts, [["first"], ["adjust", "now"], ["next"]]);
  assert.equal(output[0], event);
  assert.deepEqual(output.slice(1).map(event => event.result), ["first answer", "next answer"]);
  assert.deepEqual(query.counts(), { interrupts: 0, returned: 0 });
});

test("Claude cancellation uses native interrupt, waits for its result, and preserves the Query for later work", async () => {
  const query = nativeQuery(), controller = new AbortController(), output = [];
  const harness = claude.wrapClaude(query, { send() {} });
  let settled = false;
  const outcome = harness.run({ prompt: "hold" }, work(output, controller.signal)).catch(error => { settled = true; return error; });
  controller.abort(); await harness.cancel(); await tick();
  assert.equal(settled, false);
  query.emit(success("interrupted"));
  assert.equal((await outcome).name, "AbortError");
  assert.deepEqual(output, []);
  const next = harness.run({ prompt: "next" }, work(output));
  query.emit(success("next answer")); await next;
  assert.equal(output[0].result, "next answer");
  assert.deepEqual(query.counts(), { interrupts: 1, returned: 0 });
});

test("Claude native result errors propagate and input transport closes on incarnation shutdown", async () => {
  const query = nativeQuery();
  const harness = claude.wrapClaude(query, { send() {} });
  const result = assert.rejects(harness.run({ prompt: "fail" }, work([])), /provider failure/);
  query.emit({ type: "result", subtype: "error_during_execution", errors: ["provider failure"] }); await result;
  const input = new claude.ClaudeInput();
  const iterator = input[Symbol.asyncIterator]();
  input.send("one");
  assert.equal((await iterator.next()).value.message.content, "one");
  const pending = iterator.next();
  input.send("steer", "now");
  assert.equal((await pending).value.priority, "now");
  const end = iterator.next(); input.close();
  assert.equal((await end).done, true);
  assert.throws(() => input.send("late"), /closed/);
});

test("Claude factory waits for native initialization and closes only with the incarnation", async () => {
  let options, ready, closed = 0;
  const query = nativeQuery();
  query.initializationResult = () => new Promise(resolve => { ready = resolve; });
  query.close = () => { closed++; };
  const adapter = await load("anthropic", "@anthropic-ai/claude-agent-sdk", { query(input) { options = input; return query; } });
  const lifetime = new AbortController();
  let created = false;
  const creation = adapter.create({ signal: lifetime.signal, env: { CLAUDE_PATH: "/stock/claude" } }).then(harness => { created = true; return harness; });
  await tick(); assert.equal(created, false);
  ready({}); const harness = await creation;
  assert.equal(options.options.pathToClaudeCodeExecutable, "/stock/claude");
  assert.equal("systemPrompt" in options.options, false);
  assert.equal("tools" in options.options, false);
  const result = harness.run({ prompt: "hello" }, work([]));
  query.emit(success("hello")); await result;
  assert.equal(closed, 0);
  lifetime.abort();
  assert.equal(closed, 1);
});

test("Claude drains an interrupted turn when cancellation interrupts an output handoff", async () => {
  const query = nativeQuery(), controller = new AbortController();
  const harness = claude.wrapClaude(query, { send() {} });
  let publishing = false, settled = false;
  const outcome = harness.run({ prompt: "hold" }, {
    signal: controller.signal,
    output: { send: () => new Promise((_, reject) => {
      publishing = true;
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    }) },
  }).catch(error => { settled = true; return error; });
  query.emit({ type: "assistant", message: { content: [] } });
  while (!publishing) await tick();
  controller.abort(); await harness.cancel(); await tick();
  assert.equal(settled, false);
  query.emit(success("old turn"));
  assert.equal((await outcome).name, "AbortError");
  const output = [];
  const next = harness.run({ prompt: "new turn" }, work(output));
  query.emit(success("new answer")); await next;
  assert.equal(output[0].result, "new answer");
});

test("Claude output failure interrupts and drains the native turn before surfacing the error", async () => {
  const query = nativeQuery();
  const harness = claude.wrapClaude(query, { send() {} });
  let settled = false;
  const outcome = harness.run({ prompt: "hold" }, { ...work([]), output: { async send() { throw new Error("handoff failed"); } } }).catch(error => { settled = true; return error; });
  query.emit({ type: "assistant", message: { content: [] } }); await tick();
  assert.equal(query.counts().interrupts, 1);
  assert.equal(settled, false);
  query.emit(success("interrupted"));
  assert.match((await outcome).message, /handoff failed/);
});
