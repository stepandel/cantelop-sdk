import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-package-"));

try {
  const { stdout } = await execute(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const [pack] = JSON.parse(stdout);
  assert.equal(pack.name, "@cantelop/sdk");
  assert.equal(pack.version, "0.2.0");
  assert.ok(pack.size > 0);
  const paths = pack.files.map(({ path: file }) => file);
  assert.ok(paths.includes("dist/build.js"));
  assert.ok(paths.includes("dist/api.d.ts"));
  assert.ok(paths.includes("dist/harness.js"));
  assert.ok(paths.includes("dist/session.js"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("package.json"));
  assert.equal(paths.some((file) => /^(src|test|examples|scripts)\//.test(file)), false);

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const [name, target] of Object.entries(manifest.exports)) {
    assert.equal(typeof target.import, "string", `${name} requires an import target`);
    assert.equal(typeof target.types, "string", `${name} requires a types target`);
    assert.ok(paths.includes(target.import.replace(/^\.\//, "")), `${name} import target is not packed`);
    assert.ok(paths.includes(target.types.replace(/^\.\//, "")), `${name} types target is not packed`);
  }

  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  await execute(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temporary, pack.filename)],
    { cwd: consumer, maxBuffer: 1024 * 1024 },
  );
  await writeFile(
    path.join(consumer, "api.mjs"),
    [
      'import { defineApi } from "@cantelop/sdk/api";',
      "export default defineApi(({ router }) => {",
      '  router.route("GET", "/health", () => Response.json({ status: "ok" }));',
      "});",
    ].join("\n"),
  );
  await writeFile(
    path.join(consumer, "qualify.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { CANTELOP_CLI_BUILD_PROTOCOL_VERSION, buildApi, buildHarness, buildLocalApi, watchLocalProject } from "@cantelop/sdk/build";',
      'import { defineApi } from "@cantelop/sdk/api";',
      'import { createApiWorker } from "@cantelop/sdk/edge";',
      'import { serveHarness } from "@cantelop/sdk/harness";',
      'import { defineSessionBehaviour } from "@cantelop/sdk/session";',
      "assert.equal(typeof buildApi, \"function\");",
      "assert.equal(typeof buildHarness, \"function\");",
      "assert.equal(typeof buildLocalApi, \"function\");",
      "assert.equal(typeof watchLocalProject, \"function\");",
      "assert.equal(CANTELOP_CLI_BUILD_PROTOCOL_VERSION, 1);",
      "assert.equal(typeof defineApi, \"function\");",
      "assert.equal(typeof createApiWorker, \"function\");",
      "assert.equal(typeof defineSessionBehaviour, \"function\");",
      "assert.equal(typeof serveHarness, \"function\");",
      'await buildApi({ entrypoint: "./api.mjs", outdir: "./artifact" });',
    ].join("\n"),
  );
  await execute(process.execPath, ["qualify.mjs"], { cwd: consumer, maxBuffer: 1024 * 1024 });
  const artifactManifest = JSON.parse(await readFile(path.join(consumer, "artifact", "cantelop-api.json"), "utf8"));
  assert.equal(artifactManifest.kind, "cantelop-edge-api");
  process.stdout.write(`Qualified ${pack.filename} (${paths.length} files)\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
