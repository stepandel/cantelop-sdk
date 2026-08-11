import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionEnvironment } from "../dist/harness.js";

test("a native harness receives VM environment and emits events", async () => {
  const environment = createExecutionEnvironment(
    async ({ input, env, emit }) => {
      emit({ type: "delta", value: input.slice(0, 2) });
      emit({ type: "delta", value: input.slice(2) });
      return `${env.PREFIX}${input.toUpperCase()}`;
    },
    { env: { PREFIX: "VM:" } },
  );

  const execution = await environment.start("hello");
  const events = [];
  for await (const event of execution.events()) events.push(event);

  assert.deepEqual(events, [
    { type: "delta", value: "he" },
    { type: "delta", value: "llo" },
  ]);
  assert.equal(await execution.wait(), "VM:HELLO");
  assert.equal(execution.status, "succeeded");
});
