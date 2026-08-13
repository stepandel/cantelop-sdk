import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.equal(pack.version, "0.1.0-rc.1");
  assert.ok(pack.size > 0);
  const paths = pack.files.map(({ path: file }) => file);
  assert.ok(paths.includes("dist/build.js"));
  assert.ok(paths.includes("dist/api.d.ts"));
  assert.ok(paths.includes("dist/harness.js"));
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

  await writeFile(
    path.join(temporary, "qualification.json"),
    `${JSON.stringify({ name: pack.name, version: pack.version, filename: pack.filename, files: paths.length }, null, 2)}\n`,
  );
  process.stdout.write(`Qualified ${pack.filename} (${paths.length} files)\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
