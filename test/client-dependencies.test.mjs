import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

test("backend integration bundles without build tooling or native Session runtime", async () => {
  const result = await build({
    stdin: {
      contents: 'import { CantelopClient } from "@cantelop/sdk"; export const app = new CantelopClient({ sessionRuntime: { receive() {} }, connection: { fetch: request => fetch(request) } });',
      resolveDir: process.cwd(), loader: "js",
    },
    bundle: true, platform: "node", format: "esm", write: false, metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.equal(/(?:^|\/)dist\/(?:build|runtime|session-runtime-server|mailbox|activity|observability)\.js$/.test(input), false, input);
    assert.equal(/node_modules\/.*(?:esbuild|drizzle-kit|typescript)/.test(input), false, input);
  }
});

test("automatic App configuration bundles for worker hosts without Node profile dependencies", async () => {
  const result = await build({
    stdin: { contents: 'import { CantelopClient } from "@cantelop/sdk"; export const app = new CantelopClient({ sessionRuntime: { receive() {} } });', resolveDir: process.cwd(), loader: "js" },
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
  });
  assert.equal(Object.keys(result.metafile.inputs).some(input => /app-config-node\.js$/.test(input)), false);
  assert.equal(Object.keys(result.metafile.inputs).some(input => /app-config-empty\.js$/.test(input)), true);
});
