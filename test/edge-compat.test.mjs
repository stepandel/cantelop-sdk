import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the Edge API modules have no native harness dependencies", async () => {
  const files = ["api.js", "app.js", "execution.js", "index.js"];

  for (const file of files) {
    const source = await readFile(path.join(repositoryRoot, "dist", file), "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["']node:/);
    assert.doesNotMatch(source, /\b(?:Buffer|process)\b/);
    assert.doesNotMatch(source, /["']\.\/harness\.js["']/);
  }
});
