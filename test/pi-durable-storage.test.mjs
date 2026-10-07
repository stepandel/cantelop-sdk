import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import {
  openPiDurableStorage,
  openPiDurableHarness,
} from "../dist/pi-durable.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cantelop-pi-test-"));
  const database = createClient({ url: `file:${join(dir, "workspace.db")}` });
  return {
    database,
    async close() {
      database.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function partialDeepEqual(actual, expected) {
  if (expected === null || typeof expected !== "object")
    return assert.deepStrictEqual(actual, expected);
  assert(actual !== null && typeof actual === "object");
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
  }
  for (const [key, value] of Object.entries(expected)) {
    assert(Object.hasOwn(actual, key));
    partialDeepEqual(actual[key], value);
  }
}
const assertions = {
  ok: assert.ok,
  strictEqual: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  partialDeepEqual,
  greaterThan: (actual, expected) => assert(actual > expected),
  rejects: (operation, message) =>
    assert.rejects(operation, (error) => {
      assert(error.message.includes(message));
      return true;
    }),
};
for (const check of createStorageConformance({
  assertions,
  withStorage: async (use) => {
    const f = await fixture();
    const storage = await openPiDurableStorage(f.database, "session", ctx);
    try {
      await use(storage);
    } finally {
      await storage.close(ctx);
      await f.close();
    }
  },
}))
  test(`Pi SQL conformance: ${check.name}`, check.run);

const State = defineDoc({
  kind: "test.state",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ count: 0 }),
});
async function open(database, sessionId = "one") {
  return openPiDurableHarness(
    {
      database,
      sessionId,
      harness: { models: createModels(), registry: createRegistry() },
    },
    ctx,
  );
}

test("two harnesses share one DB with independent roots, IDs, sequences and documents", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const [a, b] = await Promise.all([
    open(f.database, "one"),
    open(f.database, "two"),
  ]);
  t.after(() => Promise.all([a.close(ctx), b.close(ctx)]));
  const [ar, br] = await Promise.all([a.root(ctx), b.root(ctx)]);
  assert.equal(ar.id, br.id);
  await Promise.all([
    ar.commit(async (tx) => {
      (await tx.doc(State, ar.id)).count = 11;
    }, ctx),
    br.commit(async (tx) => {
      (await tx.doc(State, br.id)).count = 22;
    }, ctx),
  ]);
  assert.equal((await a.snapshot(State, ar.id, ctx)).count, 11);
  assert.equal((await b.snapshot(State, br.id, ctx)).count, 22);
  await a.close(ctx);
  const reopened = await open(f.database, "one");
  t.after(() => reopened.close(ctx));
  const root = await reopened.root(ctx);
  assert.equal((await reopened.snapshot(State, root.id, ctx)).count, 11);
});

test("reopen fences stale writers without closing the shared database", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const old = await open(f.database);
  const root = await old.root(ctx);
  const next = await open(f.database);
  t.after(() => next.close(ctx));
  await assert.rejects(
    root.submit(
      { type: "write", entry: { kind: "note", data: {} }, requestId: "stale" },
      ctx,
    ),
    /fenced/,
  );
  await old.close(ctx);
  assert.equal(f.database.closed, false);
  const current = await next.root(ctx);
  await current.submit(
    { type: "write", entry: { kind: "note", data: {} }, requestId: "fresh" },
    ctx,
  );
});

test("failure after SQL commit publishes no guessed result and is resolved by reopen", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let inject = false;
  let commits = 0;
  const database = Object.create(f.database);
  database.transaction = async (mode) => {
    const tx = await f.database.transaction(mode);
    return new Proxy(tx, {
      get(target, key) {
        if (key === "commit")
          return async () => {
            await target.commit();
            commits++;
            if (inject) {
              inject = false;
              throw Error("response lost");
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const h = await open(database);
  const root = await h.root(ctx);
  inject = true;
  const before = commits;
  const draft = {
    type: "write",
    entry: { kind: "note", data: { saved: true } },
    requestId: "stable",
  };
  await assert.rejects(root.submit(draft, ctx), /unavailable/);
  assert.equal(commits, before + 1);
  await assert.rejects(root.submit(draft, ctx), /poisoned/);
  assert.equal(commits, before + 1);
  await h.close(ctx);
  const next = await open(f.database);
  t.after(() => next.close(ctx));
  const nr = await next.root(ctx);
  const receipt = await nr.submit(draft, ctx);
  assert.equal((await receipt.status(ctx)).status, "done");
  const entries = await nr.entries({}, 100, undefined, ctx);
  assert.equal(entries.items.filter((x) => x.kind === "note").length, 1);
});

test("failed SQL transaction leaves no partial records and validation errors do not poison storage", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let inject = false;
  const database = Object.create(f.database);
  database.transaction = async (mode) => {
    const tx = await f.database.transaction(mode);
    return new Proxy(tx, {
      get(target, key) {
        if (key === "execute")
          return async (sql) => {
            if (
              inject &&
              sql.sql?.startsWith("INSERT INTO cantelop_pi_commits")
            ) {
              inject = false;
              throw Error("write rejected");
            }
            return target.execute(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const h = await open(database);
  const root = await h.root(ctx);
  inject = true;
  await assert.rejects(
    root.submit(
      {
        type: "write",
        entry: { kind: "note", data: {} },
        requestId: "rolled-back",
      },
      ctx,
    ),
    /unavailable/,
  );
  await h.close(ctx);
  const next = await open(f.database);
  t.after(() => next.close(ctx));
  const nr = await next.root(ctx);
  assert.equal(
    (await nr.entries({}, 100, undefined, ctx)).items.filter(
      (x) => x.kind === "note",
    ).length,
    0,
  );
});

for (const replay of ["safe", "unsafe"])
  test(`SIGKILL recovery preserves intake and ${replay} tool intent`, async (t) => {
    const { fork } = await import("node:child_process");
    const { once } = await import("node:events");
    const { fauxProvider, fauxAssistantMessage, Type } = await import(
      "@earendil-works/pi-ai"
    );
    const { defineExtension, defineTool } = await import(
      "@earendil-works/pi-durable"
    );
    const f = await fixture();
    t.after(() => f.close());
    const row = await f.database.execute("PRAGMA database_list");
    const url = `file:${row.rows[0].file}`;
    const child = fork(
      new URL("./fixtures/pi-durable-process.mjs", import.meta.url),
      [url, replay],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    t.after(() => child.kill("SIGKILL"));
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data));
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw Error(stderr || "crash fixture exited early");
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("crash fixture timed out")),
          5000,
        );
        timer.unref();
      }),
    ]);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    let executions = 0;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("recovered")]);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "effects",
        tools: [
          defineTool({
            name: "effect",
            description: "Crash fixture",
            parameters: Type.Object({}),
            replay,
            execute: async () => {
              executions++;
              return {
                content: [{ type: "text", text: "safe effect completed" }],
              };
            },
          }),
        ],
      }),
    );
    const harness = await openPiDurableHarness(
      {
        database: f.database,
        sessionId: "agent",
        harness: { models, registry },
      },
      ctx,
    );
    t.after(() => harness.close(ctx));
    harness.resume();
    await harness.waitForIdle(ctx);
    assert.equal(executions, replay === "safe" ? 1 : 0);
    const root = await harness.root(ctx);
    const receipt = await root.submit(
      { type: "input", content: "run effect", requestId: "crash-intake" },
      ctx,
    );
    assert.equal((await receipt.status(ctx)).status, "done");
    const entries = await root.entries({}, 100, undefined, ctx);
    assert.equal(entries.items.filter((e) => e.kind === "pi.user").length, 1);
    assert(
      entries.items.some((e) =>
        JSON.stringify(e).includes(
          replay === "safe" ? "safe effect completed" : "interrupted",
        ),
      ),
    );
  });
