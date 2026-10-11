import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionRuntime } from "../dist/build.js";

const temporary = await mkdtemp(join(tmpdir(), "cantelop-database-example-"));
try {
  const projectRoot = fileURLToPath(new URL("../examples/database", import.meta.url));
  const artifact = await buildSessionRuntime({
    definition: join(projectRoot, "src/cantelop.ts"), projectRoot, outdir: temporary,
  });
  assert.equal(artifact.manifest.schema_version, 1);
  assert.deepEqual(Object.keys(artifact.manifest.database_schema.snapshot.tables), ["tasks"]);
  await import("../examples/database/build.mjs");
  const backend = await readFile(join(projectRoot, "dist/backend.js"), "utf8");
  assert.ok(backend.includes("Created by the application"));
  assert.ok(backend.includes("Created by the Session"));
  assert.ok(backend.includes(artifact.manifest.session_runtime_id));
  assert.ok(!backend.includes("message.payload.title"), "Session implementation must stay out of the backend");
  process.stdout.write("Qualified database schema and compiled application backend\n");
} finally { await rm(temporary, { recursive: true, force: true }); }
