import assert from "node:assert/strict";
import test from "node:test";
import { createHarnessExecutor } from "../dist/harness.js";

test("a native harness receives VM environment and emits events", async () => {
  const executor = createHarnessExecutor(
    async ({ input, env, session, execution: contextExecution, emit }) => {
      assert.equal(session.id, "thread");
      assert.equal(typeof contextExecution.id, "string");
      emit({ type: "delta", value: input.slice(0, 2) });
      emit({ type: "delta", value: input.slice(2) });
      return `${env.PREFIX}${input.toUpperCase()}`;
    },
    { env: { PREFIX: "VM:" } },
  );

  const execution = await executor.start("hello", {
    session: {
      id: "thread",
      workspaceId: "wsp_0123456789abcdef0123456789abcdef",
      keepAliveSeconds: 300,
    },
  });
  const events = [];
  for await (const event of execution.events()) events.push(event);

  assert.deepEqual(events, [
    { type: "delta", value: "he" },
    { type: "delta", value: "llo" },
  ]);
  assert.equal(await execution.wait(), "VM:HELLO");
  assert.equal(execution.status, "succeeded");

  await assert.rejects(executor.start("again", {
    session: {
      id: "other-thread",
      workspaceId: "wsp_0123456789abcdef0123456789abcdef",
      keepAliveSeconds: 300,
    },
  }), /already bound to a different Session/);
});
