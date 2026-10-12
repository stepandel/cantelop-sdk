import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await tick();
  }
}

// Exercise adapter boundaries without invoking a provider or a model.
async function harness(name, state, lifetime = new AbortController().signal) {
  const key = `cantelop-provider-${name}`;
  globalThis[key] = state;
  const fixture = `const state = globalThis[${JSON.stringify(key)}];\n`;
  const modules = {
    "@openai/agents": fixture + `
      export class Agent {}
      export class MemorySession {}
      export async function run(agent, prompt, { signal }) {
        const completed = new Promise(resolve => {
          signal.addEventListener("abort", () => {
            state.aborted = true;
            state.cleanup.promise.then(() => { state.exited = true; resolve(); });
          }, { once: true });
        });
        return { completed, async *toTextStream() { yield "delta"; } };
      }
    `,
    "@earendil-works/pi-agent-core": fixture + `
      export class Agent {
        subscribe(callback) { this.callback = callback; return () => { state.unsubscribed = true; }; }
        async prompt() {
          this.callback({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "delta" } });
          await state.cleanup.promise;
          state.exited = true;
        }
        abort() { state.aborted = true; }
        steer() {}
      }
    `,
    "@earendil-works/pi-ai/providers/all": `export const builtinModels = () => ({getModel: () => ({}), streamSimple() {}});`,
  };
  const bundle = await build({
    entryPoints: [new URL(`../examples/${name}/src/agent.ts`, import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "provider-fixtures", setup(build) {
      build.onResolve({ filter: /^@(?:openai|earendil-works)\// }, args => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: modules[args.path], loader: "js" }));
    } }],
  });
  const { create } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  delete globalThis[key];
  return create({ signal: lifetime, session: { id: "test" }, env: { OPENAI_API_KEY: "fixture" } });
}

for (const name of ["openai", "web-chat", "pi"]) {
  test(`${name} stops provider work on failed output and waits for cleanup`, async () => {
    const state = { cleanup: deferred(), aborted: false, exited: false };
    const adapter = await harness(name, state);
    let settled = false;
    const failed = assert.rejects(adapter.run({ type: "prompt", prompt: "hello" }, {
      signal: new AbortController().signal,
      output: { send: async () => { throw new Error("handoff failed"); } },
    }), /handoff failed/).then(() => { settled = true; });
    await until(() => state.aborted);
    assert.equal(settled, false);
    assert.equal(state.exited, false);
    state.cleanup.resolve();
    await failed;
    assert.equal(state.exited, true);
    if (name === "pi") assert.equal(state.unsubscribed, true);
  });
}
