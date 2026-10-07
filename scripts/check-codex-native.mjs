import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { startCodexWorkspaceStorage } from "../dist/codex-storage.js";

const directory = await mkdtemp(join(tmpdir(), "cantelop-codex-native-"));
const database = createClient({ url: `file:${join(directory, "test.sqlite")}`, intMode: "bigint" });
const bridge = await startCodexWorkspaceStorage(database);
try {
  const run = promisify(execFile);
  const source = process.argv[2];
  const { stdout } = await run(process.env.CANTELOP_CARGO ?? "cargo", ["+1.95.0", "run", "--locked", "--manifest-path", "native/codex-workspace/Cargo.toml", "--example", source ? "verify_upstream" : "verify_bridge", ...(source ? ["--", source] : [])], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, CANTELOP_CODEX_STORAGE_URL: bridge.url, CANTELOP_CODEX_STORAGE_TOKEN: bridge.token },
    maxBuffer: 2 * 1024 * 1024,
  });
  const tables = (await database.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")).rows.map(row => row.name);
  if (!source) assert.deepEqual(tables, ["cantelop_codex_logs__sqlx_migrations", "cantelop_codex_state__sqlx_migrations", "cantelop_codex_state_threads"]);
  process.stdout.write(stdout);
} finally {
  await bridge.close(); database.close(); await rm(directory, { recursive: true, force: true });
}
