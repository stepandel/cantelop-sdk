import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { deferred, nextTurn as tick, until } from "./helpers.mjs";

const moduleDirectory = await mkdtemp(join(tmpdir(), "provider-harness-modules-"));
after(() => rm(moduleDirectory, { recursive: true, force: true }));
let moduleSequence = 0;

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
  const modulePath = join(moduleDirectory, `module-${++moduleSequence}.mjs`);
  await writeFile(modulePath, bundle.outputFiles[0].text);
  const { create } = await import(pathToFileURL(modulePath).href);
  delete globalThis[key];
  return create({ signal: lifetime, session: { id: "test" }, env: { OPENAI_API_KEY: "fixture" } });
}

for (const name of ["openai", "web-chat", "pi"]) {
  test(`${name} stops provider work on failed output and waits for cleanup`, async () => {
    const state = { cleanup: deferred(), aborted: false, exited: false };
    const adapter = await harness(name, state);
    let settled = false;
    const failed = assert.rejects(adapter.queue({ type: "prompt", prompt: "hello" }, {
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
