import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionRuntime } from "../dist/build.js";

const temporary = await mkdtemp(join(tmpdir(), "cantelop-database-example-"));
try {
  const projectRoot = fileURLToPath(new URL("../examples/database", import.meta.url));
  const artifact = await buildSessionRuntime({
    definition: join(projectRoot, "src/definition.ts"), projectRoot, outdir: temporary,
  });
  assert.equal(artifact.manifest.schema_version, 1);
  assert.deepEqual(Object.keys(artifact.manifest.database_schema.snapshot.tables), ["tasks"]);
  process.stdout.write("Qualified database schema on the runtime artifact\n");
} finally { await rm(temporary, { recursive: true, force: true }); }
