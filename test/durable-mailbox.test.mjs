import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAILBOX_SCHEMA, TursoMailboxStore } from "../dist/mailbox-store.js";
import { DurableMailbox } from "../dist/durable-mailbox.js";

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

test("admission persists immutable identity, canonical deduplication and FIFO sequence", async (t) => {
  const { store, db } = await fixture(t);
  const first = await store.enqueue(message(1, { b: 2, a: 1 }));
  const duplicate = await store.enqueue({
    ...message(1, { a: 1, b: 2 }),
    deadline: Date.now() + 1000,
  });
  assert.equal(duplicate.sequence, first.sequence);
  assert.equal(duplicate.deadline, first.deadline);
  await assert.rejects(store.enqueue(message(1, { a: 3 })), {
    code: "message_conflict",
  });
  const second = await store.enqueue(message(2));
  assert.equal(second.sequence, 2);
  assert.equal(
    (await new TursoMailboxStore(db).get(owner.sessionId, first.id)).sequence,
    1,
  );
});
test("lost commit ACKs resolve admission, claim, settlement and parking without replay", async (t) => {
  const { db } = await fixture(t);
  const loss = commitLoss(db);
  const store = new TursoMailboxStore(loss.db);
  loss.arm();
  const entry = await store.enqueue(message(1));
  loss.arm();
  const claimed = await store.claim(owner, "claim-one");
  assert.equal(claimed.id, entry.id);
  loss.arm();
  await store.settle(owner, claimed, {
    state: "succeeded",
    reply: { ok: true },
  });
  assert.deepEqual((await store.get(owner.sessionId, entry.id)).reply, {
    ok: true,
  });
  loss.arm();
  const parked = await store.park(owner, "park-one");
  assert.equal(parked.parkToken, "park-one");
});
test("concurrent producers allocate unique Session sequences", async (t) => {
  const { url } = await fixture(t);
  const clients = Array.from({ length: 8 }, () => createClient({ url }));
  t.after(() => clients.forEach((client) => client.close()));
  const rows = await Promise.all(
    clients.map((client, i) =>
      new TursoMailboxStore(client).enqueue(message(i + 1)),
    ),
  );
  assert.deepEqual(
    rows.map((r) => r.sequence).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});
test("only one claim runs and stale epochs cannot claim or settle", async (t) => {
  const { store, db } = await fixture(t);
  await store.enqueue(message(1));
  await store.enqueue(message(2));
  const claimed = await store.claim(owner, "first");
  assert.equal(await store.claim(owner, "second"), undefined);
  await db.execute({
    sql: "UPDATE cantelop_mailbox_sessions SET epoch=2 WHERE session_id=?",
    args: [owner.sessionId],
  });
  await assert.rejects(store.settle(owner, claimed, { state: "succeeded" }), {
    code: "mailbox_ownership_lost",
  });
  await assert.rejects(store.claim(owner, "stale"), {
    code: "mailbox_ownership_lost",
  });
  assert.equal((await store.get(owner.sessionId, claimed.id)).state, "running");
});
test("queued deadlines and cancellation do not invoke the handler", async (t) => {
  const { db } = await fixture(t);
  let now = Date.now();
  const store = new TursoMailboxStore(db, () => now);
  await store.enqueue({ ...message(1), deadline: now + 100 });
  now += 101;
  assert.equal(await store.claim(owner, "expired"), undefined);
  assert.equal(
    (await store.get(owner.sessionId, message(1).id)).state,
    "timed_out",
  );
  await store.enqueue(message(2));
  await store.cancel(owner.sessionId, message(2).id);
  assert.equal(await store.claim(owner, "cancelled"), undefined);
});
test("parking and admission serialize; arrivals after parking cannot execute until resume", async (t) => {
  const { store, db } = await fixture(t);
  const parked = await store.park(owner, "park-one");
  assert.equal(parked.epoch, 1);
  await store.enqueue(message(1));
  await assert.rejects(store.claim(owner, "after-park"), {
    code: "mailbox_ownership_lost",
  });
  const next = { ...owner, epoch: 2, leaseId: "lease_" + "3".repeat(32) };
  await db.execute({
    sql: "UPDATE cantelop_mailbox_sessions SET owner_state='active',epoch=?,lease_id=?,park_token=NULL WHERE session_id=?",
    args: [next.epoch, next.leaseId, next.sessionId],
  });
  assert.equal((await store.claim(next, "new-lease")).sequence, 1);
  await assert.rejects(store.park(owner, "old-park"), {
    code: "mailbox_ownership_lost",
  });
});
test("pending work prevents parking even before a worker has fetched it", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(message(1));
  assert.equal(await store.park(owner, "early"), undefined);
});
test("adapter retains busy accounting through settlement writes and exposes a durable idle receipt", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(message(1));
  const settlement = gate();
  const entered = gate();
  const delayed = new Proxy(store, {
    get(target, key) {
      if (key === "settle")
        return async (...args) => {
          entered.resolve();
          await settlement.promise;
          return target.settle(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const mailbox = new DurableMailbox(
    delayed,
    owner.sessionId,
    async () => ({}),
    () => {},
    10000,
  );
  t.after(() => mailbox.close());
  assert.equal(mailbox.isIdle, false);
  await mailbox.resume(owner);
  await entered.promise;
  assert.equal(mailbox.isIdle, false);
  let parked = false;
  const idle = mailbox.prepareIdle().then((receipt) => {
    parked = true;
    return receipt;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(parked, false);
  settlement.resolve();
  const receipt = await idle;
  assert.equal(receipt.leaseId, owner.leaseId);
  assert.equal(mailbox.isIdle, true);
});
test("unawaited self-message admission remains tracked after its handler returns", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(message(1));
  const admission = gate();
  const entered = gate();
  const delayed = new Proxy(store, {
    get(target, key) {
      if (key === "enqueue")
        return async (value) => {
          entered.resolve();
          await admission.promise;
          return target.enqueue(value);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const received = [];
  let mailbox;
  mailbox = new DurableMailbox(
    delayed,
    owner.sessionId,
    async (row) => {
      received.push(row.id);
      if (row.id === message(1).id) void mailbox.enqueue(message(2));
      return {};
    },
    () => {},
    10000,
  );
  t.after(() => mailbox.close());
  await mailbox.resume(owner);
  await entered.promise;
  assert.equal(mailbox.isIdle, false);
  const idle = mailbox.prepareIdle();
  admission.resolve();
  await idle;
  assert.deepEqual(received, [message(1).id, message(2).id]);
});

test("memory adapter implements the same envelope, FIFO, deduplication and parking contract", async (t) => {
  const { InMemoryMailboxAdapter } = await import("../dist/memory-mailbox.js");
  const received = [];
  const mailbox = new InMemoryMailboxAdapter(owner.sessionId, async (entry) => {
    received.push(entry.sequence);
    return { reply: { ok: true } };
  });
  t.after(() => mailbox.close());
  await mailbox.enqueue({ ...message(1), replyRequested: true });
  await mailbox.enqueue(message(2));
  await mailbox.enqueue(message(2));
  await mailbox.resume(owner);
  await until(() => mailbox.isIdle);
  const receipt = await mailbox.prepareIdle();
  assert.equal(receipt.epoch, 1);
  assert.deepEqual(received, [1, 2]);
  assert.deepEqual((await mailbox.status(message(1).id)).reply, { ok: true });
  await mailbox.enqueue(message(3));
  await mailbox.resume({
    ...owner,
    epoch: 2,
    leaseId: "lease_" + "4".repeat(32),
  });
  await until(() => mailbox.isIdle);
  assert.deepEqual(received, [1, 2, 3]);
});
