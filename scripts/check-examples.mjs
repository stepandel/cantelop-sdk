import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApi, buildHarness } from "../dist/build.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const schemaUrl =
  "https://raw.githubusercontent.com/stepandel/cantelop-sdk/main/schemas/app-v1.json";
const examples = ["openai", "anthropic", "pi"];
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "cantelop-example-check-"),
);

try {
  const schema = JSON.parse(
    await readFile(path.join(repositoryRoot, "schemas/app-v1.json"), "utf8"),
  );
  assert.equal(schema.$id, schemaUrl);
  assert.ok(schema.examples.length > 0);
  for (const example of schema.examples) {
    assert.equal(example.harness, "src/session.ts");
  }

  for (const example of examples) {
    const exampleRoot = path.join(repositoryRoot, "examples", example);
    const apiSource = await readFile(path.join(exampleRoot, "src/api.ts"), "utf8");
    const contractsSource = await readFile(path.join(exampleRoot, "src/contracts.ts"), "utf8");
    const sessionSource = await readFile(path.join(exampleRoot, "src/session.ts"), "utf8");
    const routes = [...apiSource.matchAll(/router\.route\("([A-Z]+)", "([^"]+)"/g)]
      .map(([, method, route]) => `${method} ${route}`);
    assert.deepEqual(routes, [
      "GET /health",
      "POST /chat",
      "POST /steer",
      "POST /cancel",
    ]);
    assert.doesNotMatch(sessionSource, /steer:\s*steerTurn/);
    assert.doesNotMatch(sessionSource, /queuedPrompts|PromptInput|AnswerOutput/);
    assert.doesNotMatch(sessionSource, /type:\s*"message"/);
    assert.doesNotMatch(sessionSource, /No active .* to steer|already processing a prompt/);
    assert.match(sessionSource, /promptQueue\.push\(command\.prompt\)/);
    assert.match(sessionSource, /send\(\{ type: "prompt", prompt: nextPrompt \}\)/);
    assert.match(apiSource, /type:\s*"prompt"/);
    assert.match(apiSource, /type:\s*"steer"/);
    assert.match(apiSource, /type:\s*"cancel"/);
    assert.match(contractsSource, /SessionMessage/);
    assert.match(contractsSource, /SessionEvent/);
    assert.match(sessionSource, /activity\.start\(/);
    assert.match(sessionSource, /defineSessionLogic/);
    JSON.parse(await readFile(path.join(exampleRoot, "cantelop.json"), "utf8"));

    await buildApi({
      entrypoint: path.join(exampleRoot, "src/api.ts"),
      outdir: path.join(temporaryRoot, example, "api"),
    });
    await buildHarness({
      entrypoint: path.join(exampleRoot, "src/session.ts"),
      outdir: path.join(temporaryRoot, example, "harness"),
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
