import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { buildEdgeApi, buildSessionRuntime, createCantelopCompilerPlugin } from "../dist/build.js";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cantelop-examples-"));
try {
  const schema = JSON.parse(await readFile(path.join(root, "schemas/app-v3.json"), "utf8"));
  assert.deepEqual(schema.required, ["schema_version", "app", "session"]);
  assert.equal("api" in schema.properties, false);
  for (const name of ["openai", "anthropic", "pi", "opencode", "database", "web-chat"]) {
    const projectRoot = path.join(root, "examples", name);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "cantelop.json"), "utf8"));
    assert.equal(manifest.schema_version, 3);
    assert.equal("api" in manifest, false);
    await assert.rejects(access(path.join(projectRoot, "src/api.ts")), { code: "ENOENT" });
    const client = await build({
      entryPoints: [path.join(projectRoot, name === "web-chat" ? "src/server.ts" : "src/cantelop.ts")], bundle: true,
      platform: "node", format: "esm", write: false, metafile: true, plugins: [createCantelopCompilerPlugin({ definition: path.join(projectRoot, "src/cantelop.ts") })],
    });
    for (const input of Object.keys(client.metafile.inputs)) {
      assert.doesNotMatch(input, /dist\/(?:build|runtime|session-runtime-server)\.js$/);
      assert.doesNotMatch(input, /node_modules\/.*(?:@openai\/agents|@anthropic-ai|@earendil-works|@opencode-ai)/);
    }
    const session = typeof manifest.session === "string" ? manifest.session : manifest.session.entrypoint;
    const artifact = await buildSessionRuntime({
      definition: path.join(projectRoot, session), projectRoot,
      outdir: path.join(temporary, name),
    });
    const edge = await buildEdgeApi({ definition: path.join(projectRoot, session), outdir: path.join(temporary, name, 'edge') });
    assert.equal(edge.manifest.session_runtime_id, artifact.manifest.session_runtime_id);
    assert.equal(edge.manifest.kind, "cantelop-protocol-edge");
    assert.equal(edge.manifest.integration_protocol_version, 2);
    assert.deepEqual(JSON.parse(await readFile(edge.manifestFile, "utf8")), edge.manifest);
    assert.equal(artifact.manifest.kind, "cantelop-session-runtime");
    assert.doesNotMatch(await readFile(artifact.mainModule, "utf8"), /class CantelopClient/);
    assert.equal(artifact.manifest.cli_build_protocol_version, 6);
    assert.equal("routes" in artifact.manifest, false);
    assert.deepEqual(JSON.parse(await readFile(artifact.manifestFile, "utf8")), artifact.manifest);
  }
  const browser = await build({
    entryPoints: [path.join(root, "examples/web-chat/public/chat.js")],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
  });
  assert.equal(Object.keys(browser.metafile.inputs).length, 1);
  process.stdout.write("Qualified backend clients, protocol Edge Workers, and native runtime examples\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
