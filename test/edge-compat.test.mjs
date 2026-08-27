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
  const files = [
    "api.js",
    "edge.js",
    "index.js",
    "remote-app.js",
    "resources.js",
    "router.js",
  ];

  for (const file of files) {
    const source = await readFile(path.join(repositoryRoot, "dist", file), "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["']node:/);
    assert.doesNotMatch(source, /\b(?:Buffer|process)\b/);
    assert.doesNotMatch(source, /["']\.\/harness\.js["']/);
  }
});

test("only native Session behaviour exposes event output", async () => {
  const edgeContract = await readFile(
    path.join(repositoryRoot, "dist/resources.d.ts"),
    "utf8",
  );
  const sessionContract = await readFile(
    path.join(repositoryRoot, "dist/session.d.ts"),
    "utf8",
  );
  const harnessContract = await readFile(
    path.join(repositoryRoot, "dist/harness.d.ts"),
    "utf8",
  );

  assert.doesNotMatch(edgeContract, /\bSessionOutput\b/);
  assert.match(sessionContract, /interface SessionOutput<Event>/);
  assert.match(sessionContract, /send\(event: Event\): Promise<void>/);
  assert.doesNotMatch(harnessContract, /\bSessionOutput\b/);
  assert.doesNotMatch(harnessContract, /defineSessionBehaviour/);
});

test("provider API entrypoints do not import native dependencies", async () => {
  const files = [
    "examples/openai/src/api.ts",
    "examples/openai/src/contracts.ts",
    "examples/anthropic/src/api.ts",
    "examples/anthropic/src/contracts.ts",
    "examples/pi/src/api.ts",
    "examples/pi/src/contracts.ts",
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
    assert.doesNotMatch(source, /from\s+["']\.\.\//);
    assert.doesNotMatch(source, /\.events\(\)/);
    assert.doesNotMatch(source, /\/message\/stream/);
  }
});
