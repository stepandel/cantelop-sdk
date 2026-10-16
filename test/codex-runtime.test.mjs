import test from "node:test";
import assert from "node:assert/strict";
import { createCodexTestDatabase } from "../scripts/codex-test-database.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createCodexRuntime, NativeCodex } from "../dist/harnesses/codex.js";
import { createCodex } from "../dist/codex.js";
import { CodexStateStore } from "../dist/harnesses/codex-state.js";
import { CodexSessionOutput } from "../dist/harnesses/codex-protocol.js";
import { createSessionRuntimeHandler } from "../dist/runtime.js";

async function database(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-durable-"));
  const db = createCodexTestDatabase(`file:${join(root, "state.sqlite")}`);
  db.credentials = async () => ({
    url: "libsql://fixture.turso.io",
    authToken: "unused",
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  });
  t.after(() => {
    db.close();
    return rm(root, { recursive: true, force: true });
  });
  return { db, root };
}
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
}
function fake() {
  const runs = [];
  return {
    runs,
    create(context, options) {
      return {
        async queue(message, work) {
          await work.output.send({
            method: "thread/started",
            params: {
              thread: { id: options.conversation?.id ?? "thread-stable" },
            },
          });
          return new Promise((resolve, reject) => {
            runs.push({ text: message.prompt, options, work, resolve, reject });
            work.signal.addEventListener(
              "abort",
              () => reject(work.signal.reason),
              { once: true },
            );
            if (work.signal.aborted) reject(work.signal.reason);
          });
        },
        steer() {
          throw new Error("Runtime owns durable steering");
        },
        cancel() {
          return false;
        },
      };
    },
  };
}
async function runtime(
  t,
  db,
  factory,
  options = {},
  output = async () => {},
  sessionId = "session-a",
) {
  const behaviour = createCodexRuntime(options, factory);
  const controller = new AbortController();
  const tasks = [],
    errors = [],
    events = [];
  let active = false,
    mailbox = Promise.resolve();
  const replies = [];
  const emit = async (event) => {
    await output(event);
    events.push(event);
  };
  const context = {
    signal: controller.signal,
    session: { id: sessionId },
    env: {},
    database: async () => db,
    output: { send: emit },
    view: { commit: async () => {} },
    send: async (command) => {
      void send(command).catch((error) => errors.push(error));
    },
  };
  const activity = {
    get active() {
      return active;
    },
    extend() {},
    start(work, options) {
      assert.equal(active, false);
      active = true;
      const pending = [];
      const task = Promise.resolve()
        .then(() =>
          work({
            signal: controller.signal,
            output: { send: emit },
            view: context.view,
            send: (command) => pending.push(command),
          }),
        )
        .catch((error) => errors.push(error))
        .finally(() => {
          active = false;
          for (const command of pending)
            void send(command).catch((error) => errors.push(error));
        });
      tasks.push(task);
    },
  };
  Object.assign(context, { activity });
  function send(payload) {
    const next = mailbox.then(() =>
      behaviour.receive({
        ...context,
        command: { type: "dispatch" },
        message: { id: crypto.randomUUID(), sequence: 1, payload },
        reply: (value) => replies.push(value),
      }),
    );
    mailbox = next.catch(() => {});
    return next;
  }
  await behaviour.onActivate(context);
  t.after(async () => {
    controller.abort();
    await Promise.allSettled(tasks);
  });
  return {
    behaviour,
    send,
    events,
    replies,
    errors,
    tasks,
    controller,
    async snapshot() {
      await send({ type: "snapshot" });
      return replies.at(-1);
    },
    async log(after = 0, limit = 100) {
      await send({ type: "events", after, limit });
      return replies.at(-1);
    },
  };
}

test("intake commits once, snapshots hide settings, and retries never rerun work", async (t) => {
  const { db } = await database(t),
    native = fake();
  const app = await runtime(t, db, native.create, { model: "default-model" });
  const command = {
    type: "queue",
    id: "first",
    text: "Inspect",
    settings: { systemPrompt: "private rules" },
  };
  await app.send(command);
  await until(() => native.runs.length === 1);
  await app.send(command);
  await assert.rejects(app.send({ ...command, text: "Changed" }), /conflict/);
  assert.equal(native.runs.length, 1);
  assert.equal(native.runs[0].options.model, "default-model");
  assert.doesNotMatch(
    JSON.stringify(await app.snapshot()),
    /private rules|settings|fingerprint/,
  );
  native.runs[0].resolve();
  await until(
    async () => (await app.snapshot()).messages[0].status === "completed",
  );
  await app.send(command);
  assert.equal(native.runs.length, 1);
  const log = await app.log();
  assert.deepEqual(
    log.events.filter((e) => e.type === "message.status").map((e) => e.status),
    ["queued", "running", "completed"],
  );
  assert.deepEqual(
    log.events.map((e) => e.seq),
    log.events.map((_, i) => i + 1),
  );
});

test("every activation resumes queued input while unsafe running input remains interrupted", async (t) => {
  const { db } = await database(t);
  const stored = await CodexStateStore.open(db, "session-a");
  await stored.update((state) => {
    state.threadId = "thread-before-restart";
    state.messages.push(
      {
        id: "unsafe",
        text: "Charge",
        status: "running",
        fingerprint: "a",
        settings: {},
      },
      {
        id: "pending",
        text: "Inspect",
        status: "queued",
        fingerprint: "b",
        settings: { model: "saved-model" },
      },
    );
    state.queue.push("pending");
    return [];
  });
  const native = fake(),
    app = await runtime(t, db, native.create);
  await until(() => native.runs.length === 1);
  assert.equal(native.runs[0].text, "Inspect");
  assert.equal(native.runs[0].options.conversation.id, "thread-before-restart");
  assert.equal(native.runs[0].options.model, "saved-model");
  assert.equal((await app.snapshot()).messages[0].status, "interrupted");
  native.runs[0].resolve();
  await until(
    async () => (await app.snapshot()).messages[1].status === "completed",
  );
});

test("cancellation intent and steering survive replacement; queued work is isolated per Session", async (t) => {
  const { db } = await database(t),
    native = fake();
  const app = await runtime(t, db, native.create);
  await app.send({ type: "queue", id: "first", text: "First" });
  await until(() => native.runs.length === 1);
  await app.send({ type: "queue", id: "last", text: "Last" });
  await app.send({ type: "steer", id: "redirect", text: "Redirect" });
  await until(() => native.runs.length === 2);
  assert.equal(native.runs[1].text, "Redirect");
  assert.equal((await app.snapshot()).messages[0].status, "steered");
  await app.send({ type: "cancel", id: "last" });
  await app.send({ type: "cancel", id: "redirect" });
  await until(
    async () => (await app.snapshot()).messages[2].status === "cancelled",
  );
  assert.equal((await app.snapshot()).messages[1].status, "cancelled");
  assert.equal(native.runs.length, 2);
  const other = await runtime(t, db, fake().create, {}, undefined, "session-b");
  assert.equal((await other.snapshot()).messages.length, 0);
  assert.equal((await other.log()).events.length, 0);
});

test("committed output survives broken delivery, paginates and reconstructs oversized native events", async (t) => {
  const { db } = await database(t),
    native = fake();
  const app = await runtime(t, db, native.create, {}, async () => {
    throw new Error("Disconnected observer");
  });
  await app.send({ type: "queue", id: "large", text: "Large" });
  await until(() => native.runs.length === 1);
  const event = {
    method: "item/agentMessage/delta",
    params: { delta: "世界".repeat(40_000) },
  };
  await native.runs[0].work.output.send(event);
  native.runs[0].resolve();
  await until(
    async () => (await app.snapshot()).messages[0].status === "completed",
  );
  const decoder = new CodexSessionOutput("large");
  const decoded = [];
  let after = 0,
    pages = 0;
  do {
    const page = await app.log(after, 5);
    pages++;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
    for (const item of page.events) {
      const native = decoder.accept(item);
      if (native) decoded.push(native);
    }
    assert.ok(page.cursor >= after);
    after = page.cursor;
    if (!page.hasMore) break;
  } while (pages < 100);
  assert.ok(pages > 1);
  assert.deepEqual(decoded.at(-1), event);
  assert.equal(after, (await app.snapshot()).cursor);
});

test("a replacement fences old writers and ambiguous commits are never retried", async (t) => {
  const { db } = await database(t);
  const old = await CodexStateStore.open(db, "same"),
    replacement = await CodexStateStore.open(db, "same");
  await assert.rejects(
    old.update((state) => {
      state.threadId = "stale";
      return [];
    }),
    /fenced/,
  );
  assert.equal(replacement.state.threadId, undefined);
  let commits = 0;
  const ambiguous = { executeMultiple: db.executeMultiple.bind(db) };
  ambiguous.transaction = async (mode) => {
    const tx = await db.transaction(mode),
      commit = tx.commit.bind(tx);
    tx.commit = async () => {
      await commit();
      if (++commits === 2) throw new Error("Lost commit response");
    };
    return tx;
  };
  const store = await CodexStateStore.open(ambiguous, "ambiguous");
  await assert.rejects(
    store.update((state) => {
      state.threadId = "committed";
      return [];
    }),
    /Lost commit/,
  );
  await assert.rejects(
    store.update(() => []),
    /Lost commit/,
  );
  assert.equal(commits, 2);
  assert.equal(
    (await CodexStateStore.open(db, "ambiguous")).state.threadId,
    "committed",
  );
});

test("lost intake response recovers committed work without another user message", async (t) => {
  const { db } = await database(t),
    native = fake();
  let failNext = false;
  const unstable = {
    executeMultiple: db.executeMultiple.bind(db),
    execute: db.execute.bind(db),
    async transaction(mode) {
      const tx = await db.transaction(mode),
        commit = tx.commit.bind(tx);
      tx.commit = async () => {
        await commit();
        if (failNext) {
          failNext = false;
          throw new Error("Lost intake response");
        }
      };
      return tx;
    },
  };
  const app = await runtime(t, unstable, native.create);
  failNext = true;
  const command = { type: "queue", id: "accepted", text: "Committed intake" };
  await assert.rejects(app.send(command), /Lost intake response/);
  await until(() => native.runs.length === 1);
  await app.send(command);
  native.runs[0].resolve();
  await until(
    async () => (await app.snapshot()).messages[0].status === "completed",
  );
  assert.deepEqual(
    native.runs.map((run) => run.text),
    ["Committed intake"],
  );
});

test("lost admission response reopens state and retries only work that never entered native execution", async (t) => {
  const { db } = await database(t),
    native = fake();
  let commits = 0;
  const unstable = {
    executeMultiple: db.executeMultiple.bind(db),
    execute: db.execute.bind(db),
    async transaction(mode) {
      const tx = await db.transaction(mode),
        commit = tx.commit.bind(tx);
      tx.commit = async () => {
        await commit();
        if (++commits === 4) throw new Error("Lost running-state response");
      };
      return tx;
    },
  };
  const app = await runtime(t, unstable, native.create);
  await app.send({ type: "queue", id: "safe", text: "Admitted once" });
  await until(() => native.runs.length === 1);
  native.runs[0].resolve();
  await until(
    async () => (await app.snapshot()).messages[0].status === "completed",
  );
  assert.deepEqual(
    native.runs.map((run) => run.text),
    ["Admitted once"],
  );
  assert.ok(commits > 4);
});

test("a storage outage holds ownership, resolves committed output, and drains pending work without new input", async (t) => {
  const { db } = await database(t),
    native = fake();
  let failNext = false,
    blocked = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const unstable = {
    execute: db.execute.bind(db),
    async executeMultiple(sql) {
      if (blocked) await gate;
      return db.executeMultiple(sql);
    },
    async transaction(mode) {
      const tx = await db.transaction(mode),
        commit = tx.commit.bind(tx);
      tx.commit = async () => {
        await commit();
        if (failNext) {
          failNext = false;
          blocked = true;
          throw new Error("Lost event commit response");
        }
      };
      return tx;
    },
  };
  const app = await runtime(t, unstable, native.create);
  await app.send({ type: "queue", id: "unsafe", text: "Unsafe effect" });
  await until(() => native.runs.length === 1);
  await app.send({ type: "queue", id: "pending", text: "Pending work" });
  failNext = true;
  const event = {
    method: "item/agentMessage/delta",
    params: { delta: "Committed before the response was lost" },
  };
  try {
    await native.runs[0].work.output.send(event);
    assert.fail("Expected lost commit response");
  } catch (error) {
    native.runs[0].reject(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(native.runs.length, 1);
  release();
  await until(() => native.runs.length === 2);
  assert.deepEqual(
    native.runs.map((run) => run.text),
    ["Unsafe effect", "Pending work"],
  );
  native.runs[1].resolve();
  await until(
    async () => (await app.snapshot()).messages[1].status === "completed",
  );
  assert.equal((await app.snapshot()).messages[0].status, "interrupted");
  const page = await app.log();
  assert.equal(
    page.events.filter(
      (item) => item.type === "codex" && item.event.method === event.method,
    ).length,
    1,
  );
});

test("an old runtime cannot reclaim ownership from its replacement during recovery", async (t) => {
  const { db } = await database(t),
    native = fake();
  const old = await runtime(t, db, native.create);
  await old.send({ type: "queue", id: "old", text: "Old owner" });
  await until(() => native.runs.length === 1);
  const replacement = await CodexStateStore.open(db, "session-a");
  const owner = String(
    (
      await db.execute(
        "SELECT writer FROM cantelop_codex_sessions WHERE session_id='session-a'",
      )
    ).rows[0].writer,
  );
  try {
    await native.runs[0].work.output.send({ method: "progress", params: {} });
    assert.fail("Expected fencing");
  } catch (error) {
    native.runs[0].reject(error);
  }
  await until(() => old.errors.length > 0);
  await assert.rejects(old.send({ type: "snapshot" }), /stopped/);
  assert.equal(
    String(
      (
        await db.execute(
          "SELECT writer FROM cantelop_codex_sessions WHERE session_id='session-a'",
        )
      ).rows[0].writer,
    ),
    owner,
  );
  await replacement.update(() => []);
});

test("reopening recognizes its own ambiguously committed ownership claim", async (t) => {
  const { db } = await database(t);
  let commits = 0;
  const unstable = {
    executeMultiple: db.executeMultiple.bind(db),
    async transaction(mode) {
      const tx = await db.transaction(mode),
        commit = tx.commit.bind(tx);
      tx.commit = async () => {
        await commit();
        if (++commits === 2) throw new Error("Lost ownership response");
      };
      return tx;
    },
  };
  const original = await CodexStateStore.open(unstable, "claim");
  await assert.rejects(original.reopen(), /Lost ownership/);
  const restored = await original.reopen(db);
  await restored.update((state) => {
    state.threadId = "same-incarnation";
    return [];
  });
  assert.equal(restored.state.threadId, "same-incarnation");
});

test("native harness persists and resumes its thread across replacement processes", async (t) => {
  const { db, root } = await database(t);
  const executable = {
    command: process.execPath,
    args: [
      new URL("./fixtures/codex-app-server.mjs", import.meta.url).pathname,
    ],
  };
  const connect = async (options) => {
    assert.notEqual(options.database, db);
    const credentials = await options.database.credentials();
    assert.equal(credentials.url, (await db.credentials()).url);
    assert.equal(credentials.authToken, "unused");
    return createCodex({ ...options, executable, database: db });
  };
  const events = [];
  const work = {
    signal: new AbortController().signal,
    output: { send: async (event) => events.push(event) },
    view: { commit: async () => {} },
    send() {},
    message: { id: "m", sequence: 1 },
    session: { id: "native" },
    env: {},
    database: async () => db,
  };
  for (const prompt of ["first", "second"]) {
    const native = new NativeCodex(
      { workspace: root, sessionId: "native" },
      undefined,
      connect,
    );
    await native.queue({ type: "prompt", prompt }, work);
  }
  const starts = events.filter((event) => event.method === "thread/started");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].params.thread.id, starts[1].params.thread.id);
  assert.equal(
    (await db.execute("SELECT COUNT(*) AS count FROM codex_fixture_threads"))
      .rows[0].count,
    1n,
  );
});

test("SIGKILL after an unsafe effect retains accepted work and never repeats the effect", async (t) => {
  const { root } = await database(t);
  const fixture = new URL(
    "./fixtures/codex-runtime-process.mjs",
    import.meta.url,
  );
  const start = (mode) =>
    spawn(process.execPath, [fixture.pathname, root, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  const child = start("crash");
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  await until(() => output.includes("ADMITTED"));
  child.kill("SIGKILL");
  await once(child, "close");
  const replacement = start("recover");
  t.after(() => replacement.kill("SIGKILL"));
  let recovered = "",
    errors = "";
  replacement.stdout.on("data", (data) => {
    recovered += data;
  });
  replacement.stderr.on("data", (data) => {
    errors += data;
  });
  const [code] = await once(replacement, "close");
  assert.equal(code, 0, errors);
  assert.deepEqual(
    (await readFile(join(root, "effects"), "utf8")).trim().split("\n"),
    ["unsafe", "pending"],
  );
  const state = JSON.parse(recovered.trim());
  assert.deepEqual(
    state.messages.map((message) => message.status),
    ["interrupted", "completed"],
  );
});

test("real runtime keeps native work alive after intake settles and supports targeted cancellation", async (t) => {
  const { db } = await database(t),
    native = fake();
  const durable = createCodexRuntime({ activityTimeoutMs: 90 }, native.create);
  const wrapped = {
    ...durable,
    onActivate: (context) =>
      durable.onActivate({ ...context, database: async () => db }),
    receive: (context) =>
      durable.receive({ ...context, database: async () => db }),
  };
  const sandboxId = "sbx-" + "a".repeat(32);
  const server = createServer(
    createSessionRuntimeHandler(wrapped, { sandboxId }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "X-Cantelop-Sandbox-ID": sandboxId,
    "Content-Type": "application/json",
  };
  async function dispatch(sequence, message) {
    const response = await fetch(url + "/__cantelop/v2/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session: {
          id: "http-session",
          workspace_id: "wsp_" + "b".repeat(32),
          keep_alive_seconds: 0,
        },
        message: {
          id: "msg_" + String(sequence).padStart(32, "0"),
          payload: { __cantelop_command: 2, type: "dispatch", message },
        },
      }),
    });
    assert.equal(response.status, 202, await response.text());
  }
  const state = async () =>
    JSON.parse(
      String(
        (
          await db.execute(
            "SELECT state FROM cantelop_codex_sessions WHERE session_id='http-session'",
          )
        ).rows[0].state,
      ),
    );
  await dispatch(1, { type: "queue", id: "long", text: "Keep working" });
  await until(() => native.runs.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(
    native.runs[0].work.signal.aborted,
    false,
    "renewal uses activation capabilities after the intake invocation closes",
  );
  assert.equal((await state()).messages[0].status, "running");
  const status = await (
    await fetch(url + "/__cantelop/v2/runtime", { headers })
  ).json();
  assert.equal(status.quiescent, false);
  assert.equal(status.capabilities.redelivery, true);
  await dispatch(2, { type: "cancel", id: "long" });
  await until(async () => (await state()).messages[0].status === "cancelled");
});
