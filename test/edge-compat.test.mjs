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

test("provider API entrypoints do not import native dependencies", async () => {
  const files = [
    "examples/openai/src/api.ts",
    "examples/anthropic/src/api.ts",
    "examples/pi/src/api.ts",
    "examples/shared/contracts.ts",
    "examples/shared/event-stream.ts",
    "examples/shared/prompt-api.ts",
  ];

  for (const file of files) {
    const source = await readFile(path.join(repositoryRoot, file), "utf8");
    assert.doesNotMatch(source, /["']node:/);
    assert.doesNotMatch(
      source,
      /@(?:anthropic-ai|earendil-works|openai)\//,
    );
    assert.doesNotMatch(source, /@cantelop\/sdk\/harness/);
    assert.doesNotMatch(source, /\b(?:Buffer|process)\b/);
  }
});
