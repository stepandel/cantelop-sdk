import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildApi, buildSessionRuntime } from "../dist/build.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const schemaUrl =
  "https://raw.githubusercontent.com/stepandel/cantelop-sdk/main/schemas/app-v2.json";
const examples = ["openai", "anthropic", "pi"];
const validWorkspaceSlug = "user-1";
const expectedEnvironment = {
  openai: {
    OPENAI_MODEL: { default: "gpt-5-mini" },
    OPENAI_API_KEY: { secret: true, required: true },
  },
  anthropic: {
    ANTHROPIC_API_KEY: { secret: true, required: true },
  },
  pi: {
    ANTHROPIC_API_KEY: { secret: true, required: true },
    PI_PROVIDER: { default: "anthropic" },
    PI_MODEL: { default: "claude-sonnet-5" },
  },
};
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "cantelop-example-check-"),
);

try {
  const schema = JSON.parse(
    await readFile(path.join(repositoryRoot, "schemas/app-v2.json"), "utf8"),
  );
  assert.equal(schema.$id, schemaUrl);
  assert.ok(schema.examples.length > 0);
  for (const example of schema.examples) {
    assert.equal(example.session, "src/session.ts");
  }
  assert.equal(schema.examples[1].environment.OPENAI_MODEL.default, "gpt-5-mini");

  const rootReadme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  assert.doesNotMatch(rootReadme, /`\[[^`]+\]\([^)]+\)`/);

  for (const example of examples) {
    const exampleRoot = path.join(repositoryRoot, "examples", example);
    const apiSource = await readFile(path.join(exampleRoot, "src/api.ts"), "utf8");
    const contractsSource = await readFile(path.join(exampleRoot, "src/contracts.ts"), "utf8");
    const sessionSource = await readFile(path.join(exampleRoot, "src/session.ts"), "utf8");
    const routes = [...apiSource.matchAll(/router\.route\("([A-Z]+)", "([^"]+)"/g)]
      .map(([, method, route]) => `${method} ${route}`);
    assert.deepEqual(routes, [
      "GET /health",
      "GET /events",
      "POST /chat",
      "POST /steer",
      "POST /cancel",
    ]);
    assert.doesNotMatch(sessionSource, /steer:\s*steerTurn/);
    assert.doesNotMatch(sessionSource, /queuedPrompts|PromptInput|AnswerOutput/);
    assert.doesNotMatch(sessionSource, /type:\s*"message"/);
    assert.doesNotMatch(sessionSource, /No active .* to steer|already processing a prompt/);
    if (example === "anthropic") {
      assert.doesNotMatch(sessionSource, /promptQueue/);
      assert.match(sessionSource, /AsyncIterable<SDKUserMessage>/);
      assert.match(sessionSource, /command\.type === "steer" \? "now" : "later"/);
    } else {
      assert.match(sessionSource, /promptQueue\.push\(command\.prompt\)/);
      assert.match(sessionSource, /send\(\{ type: "prompt", prompt: nextPrompt \}\)/);
    }
    assert.match(apiSource, /type:\s*"prompt"/);
    assert.match(apiSource, /type:\s*"steer"/);
    assert.match(apiSource, /type:\s*"cancel"/);
    assert.match(apiSource, /session\.events\(request\)/);
    assert.match(contractsSource, /SessionMessage/);
    assert.match(contractsSource, /SessionEvent/);
    assert.match(sessionSource, /activity\.start\(/);
    assert.match(sessionSource, /defineSessionBehaviour/);
    const manifest = JSON.parse(
      await readFile(path.join(exampleRoot, "cantelop.json"), "utf8"),
    );
    assert.deepEqual(manifest.environment, expectedEnvironment[example]);
    if (example === "openai") {
      assert.match(sessionSource, /OPENAI_MODEL \?\? "gpt-5-mini"/);
    }
    if (example === "pi") {
      assert.match(sessionSource, /PI_MODEL \?\? "claude-sonnet-5"/);
      assert.match(sessionSource, /agent\?\.clearAllQueues\(\)/);
    }

    const apiArtifact = await buildApi({
      entrypoint: path.join(exampleRoot, "src/api.ts"),
      outdir: path.join(temporaryRoot, example, "api"),
    });
    const worker = (await import(
      `${pathToFileURL(apiArtifact.mainModule).href}?example=${example}`
    )).default;
    const invalidRequests = [
      new Request("https://example.invalid/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      jsonRequest("/chat", {
        workspaceSlug: validWorkspaceSlug,
        keepAliveSeconds: -1,
        prompt: "hello",
      }),
      jsonRequest("/steer", {
        sessionId: "invalid session",
        workspaceSlug: validWorkspaceSlug,
        keepAliveSeconds: 30,
        prompt: "hello",
      }),
      jsonRequest("/cancel", {
        sessionId: "session-1",
        workspaceSlug: "invalid--workspace",
        keepAliveSeconds: 30,
      }),
      new Request(
        "https://example.invalid/events?sessionId=&workspaceSlug=&keepAliveSeconds=604801",
      ),
    ];
    for (const request of invalidRequests) {
      const response = await worker.fetch(request);
      assert.equal(response.status, 400, `${example}: ${request.method} ${request.url}`);
    }
    await buildSessionRuntime({
      entrypoint: path.join(exampleRoot, "src/session.ts"),
      outdir: path.join(temporaryRoot, example, "session-runtime"),
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function jsonRequest(route, body) {
  return new Request(`https://example.invalid${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
