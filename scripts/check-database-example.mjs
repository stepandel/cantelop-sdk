import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const temporary = await mkdtemp(join(tmpdir(), "cantelop-database-example-"));
try {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { buildApi, buildSessionRuntime } from "@cantelop/sdk/build";
    const api = await buildApi({ entrypoint: "src/api.ts", outdir: process.argv[1] });
    await buildSessionRuntime({ entrypoint: "src/session.ts", outdir: process.argv[2] });
    console.log(JSON.stringify(api.manifest));
  `, join(temporary, "api"), join(temporary, "session")], { cwd: new URL("../examples/database", import.meta.url), maxBuffer: 2 * 1024 * 1024 });
  const manifest = JSON.parse(stdout.trim());
  assert.equal(manifest.schema_version, 4);
  assert.deepEqual(Object.keys(manifest.database_schema.snapshot.tables), ["tasks"]);
  assert.deepEqual(manifest.routes, [{ method: "GET", path: "/tasks" }, { method: "POST", path: "/tasks" }]);
  process.stdout.write("Qualified typed database schema example\n");
} finally { await rm(temporary, { recursive: true, force: true }); }
