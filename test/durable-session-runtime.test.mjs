import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAILBOX_SCHEMA, TursoMailboxStore } from "../dist/mailbox-store.js";
import { DurableMailbox } from "../dist/durable-mailbox.js";
import { createSessionRuntimeHandler } from "../dist/runtime.js";
import { createServer } from "node:http";

const owner = {
  sessionId: "test-session",
  sandboxId: "sbx-" + "1".repeat(32),
  epoch: 1,
  leaseId: "lease_" + "2".repeat(32),
};
const message = (n, payload = n) => ({
  id: "msg_" + n.toString(16).padStart(32, "0"),
  sessionId: owner.sessionId,
  payload,
  keepAliveSeconds: 0,
});
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cantelop-mailbox-"));
  const db = createClient({ url: "file:" + join(directory, "mailbox.db") });
  await db.batch([...MAILBOX_SCHEMA], "write");
  await db.execute({
    sql: "INSERT INTO cantelop_mailbox_sessions(session_id,epoch,sandbox_id,lease_id,owner_state,updated_at) VALUES(?,?,?,?,'active',?)",
    args: [
      owner.sessionId,
      owner.epoch,
      owner.sandboxId,
      owner.leaseId,
      Date.now(),
    ],
  });
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    db,
    url: "file:" + join(directory, "mailbox.db"),
    store: new TursoMailboxStore(db),
  };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("condition timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function commitLoss(db) {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    db: new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return async (mode) => {
            const tx = await target.transaction(mode);
            return new Proxy(tx, {
              get(tx, key) {
                if (key === "commit")
                  return async () => {
                    await tx.commit();
                    if (armed) {
                      armed = false;
                      throw Error("lost commit ACK");
                    }
                  };
                const value = Reflect.get(tx, key);
                return typeof value === "function" ? value.bind(tx) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

test("durable runtime reads queued work, returns replies, and parks through the HTTP contract", async (t) => {
  const { store, db } = await fixture(t);
  await store.enqueue({ ...message(1, { input: true }), replyRequested: true });
  const handler = createSessionRuntimeHandler(
    {
      receive(context) {
        context.reply({ sequence: context.message.sequence });
      },
    },
    { sandboxId: owner.sandboxId, env: {}, mailboxDatabase: db },
  );
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) =>
    fetch(origin + "/__cantelop/v2/runtime" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "X-Cantelop-Sandbox-ID": owner.sandboxId,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal(
    (await (await call("")).json()).capabilities.durable_mailbox,
    true,
  );
  const identity = {
    id: owner.sessionId,
    workspace_id: "wsp_" + "4".repeat(32),
    keep_alive_seconds: 0,
  };
  assert.equal(
    (await call("/resume", { session: identity, ownership: owner })).status,
    200,
  );
  await until(
    async () =>
      (await store.get(owner.sessionId, message(1).id)).state === "succeeded",
  );
  assert.deepEqual((await store.get(owner.sessionId, message(1).id)).reply, {
    sequence: 1,
  });
  await until(async () => (await (await call("")).json()).local_idle);
  const receipt = await (await call("/prepare-idle", {})).json();
  assert.equal(receipt.epoch, 1);
  await store.enqueue(message(2));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    (await store.get(owner.sessionId, message(2).id)).state,
    "queued",
  );
});
