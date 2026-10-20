import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { buildEdgeApi, buildSessionRuntime, buildAppArtifacts, createCantelopCompilerPlugin, CANTELOP_CLI_BUILD_PROTOCOL_VERSION } from "../dist/build.js";
import { CANTELOP_INTEGRATION_PROTOCOL_VERSION } from "../dist/index.js";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cantelop-examples-"));
try {
  for (const name of ["codex", "openai", "anthropic", "pi", "opencode", "web-chat", "github"]) {
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
      assert.doesNotMatch(input, /(?:src|dist)\/harnesses\/(?:cli|login|queue|native|durable-file)\.(?:js|ts)$/);
      assert.doesNotMatch(input, /node_modules\/.*(?:@openai\/(?:agents|codex)|@anthropic-ai|@earendil-works|@opencode-ai)/);
      assert.doesNotMatch(input, /examples\/(?:codex|anthropic|opencode)\/src\/(?:agent|native)/);
    }
    const session = typeof manifest.definition === "string" ? manifest.definition : manifest.definition.entrypoint;
    const artifact = await buildSessionRuntime({
      definition: path.join(projectRoot, session), projectRoot,
      outdir: path.join(temporary, name),
    });
    const edge = await buildEdgeApi({ definition: path.join(projectRoot, session), outdir: path.join(temporary, name, 'edge') });
    assert.equal(edge.manifest.session_runtime_id, artifact.manifest.session_runtime_id);
    if (name === "github") {
      assert.equal(edge.manifest.homepage, true);
      assert.deepEqual(edge.manifest.webhooks, [{ path: "/webhooks/github", method: "POST" }]);
      assert.doesNotMatch(await readFile(artifact.mainModule, "utf8"), /X-Hub-Signature-256/);
      assert.match(await readFile(edge.mainModule, "utf8"), /X-Hub-Signature-256/);
      assert.doesNotMatch(await readFile(edge.mainModule, "utf8"), /Suggest a concise, helpful next step/);
    }
    assert.equal(edge.manifest.kind, "cantelop-protocol-edge");
    assert.equal(edge.manifest.integration_protocol_version, CANTELOP_INTEGRATION_PROTOCOL_VERSION);
    assert.deepEqual(JSON.parse(await readFile(edge.manifestFile, "utf8")), edge.manifest);
    if (["codex", "anthropic", "opencode"].includes(name)) {
      if (name === "anthropic") {
        const { claudeDockerfile } = await import("../dist/harnesses/claude.js");
        assert.equal(artifact.manifest.dockerfile, claudeDockerfile);
        const image = await readFile(path.join(projectRoot, claudeDockerfile), "utf8");
        assert.match(image, /npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
        assert.doesNotMatch(image, /^COPY /m);
      } else {
        assert.equal(artifact.manifest.dockerfile, "docker/Dockerfile");
        const example = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
        const cli = `${example.nativeCli.package}@${example.nativeCli.version}`;
        const image = await readFile(path.join(projectRoot, "docker/Dockerfile"), "utf8");
        assert.ok(image.includes(cli), `${name} image must install the pinned stock CLI`);
      }
    }
    assert.equal(artifact.manifest.kind, "cantelop-session-runtime");
    assert.doesNotMatch(await readFile(artifact.mainModule, "utf8"), /class CantelopClient/);
    assert.equal(artifact.manifest.cli_build_protocol_version, CANTELOP_CLI_BUILD_PROTOCOL_VERSION);
    assert.equal("routes" in artifact.manifest, false);
    assert.deepEqual(JSON.parse(await readFile(artifact.manifestFile, "utf8")), artifact.manifest);
  }
  const multiRoot = path.join(root, "examples/multi-app");
  const multi = await buildAppArtifacts({ definition: path.join(multiRoot, "src/cantelop.ts"), projectRoot: multiRoot, outdir: path.join(temporary, "multi-app") });
  assert.deepEqual(multi.apps.map(app => app.name), ["support-agent", "research-agent"]);
  assert.equal(multi.backend.manifest.apps.length, 2);
  for (const app of multi.apps) {
    assert.equal(app.runtime.manifest.app_name, app.name);
    assert.equal(app.edge.manifest.session_runtime_id, app.runtime.manifest.session_runtime_id);
    assert.doesNotMatch(await readFile(app.runtime.mainModule, "utf8"), /class CantelopClient/);
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
