import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

test("backend integration bundles without build tooling or native Session runtime", async () => {
  const result = await build({
    stdin: {
      contents: 'import { createApp } from "@cantelop/sdk"; export const app = createApp({ connection: { fetch: request => fetch(request) } });',
      resolveDir: process.cwd(), loader: "js",
    },
    bundle: true, platform: "node", format: "esm", write: false, metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.equal(/(?:^|\/)dist\/(?:build|runtime|session-runtime-server|mailbox|activity|observability)\.js$/.test(input), false, input);
    assert.equal(/node_modules\/.*(?:esbuild|drizzle-kit)/.test(input), false, input);
  }
});
