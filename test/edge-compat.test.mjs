import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the published runtime has no Node imports or globals", async () => {
  const files = (await readdir(path.join(repositoryRoot, "dist")))
    .filter((file) => file.endsWith(".js"));

  assert.ok(files.length > 0, "the build should contain JavaScript modules");

  for (const file of files) {
    const source = await readFile(path.join(repositoryRoot, "dist", file), "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["']node:/);
    assert.doesNotMatch(source, /\b(?:Buffer|process)\b/);
  }
});
