import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionEnvironment } from "../dist/harness.js";

test("an execution exposes emitted harness events", async () => {
  const environment = createExecutionEnvironment(async ({ input, emit }) => {
    emit({ type: "delta", value: input.slice(0, 2) });
    emit({ type: "delta", value: input.slice(2) });
    return input.toUpperCase();
  });

  const execution = await environment.start("hello");
  const events = [];
  for await (const event of execution.events()) events.push(event);

  assert.deepEqual(events, [
    { type: "delta", value: "he" },
    { type: "delta", value: "llo" },
  ]);
  assert.equal(await execution.wait(), "HELLO");
  assert.equal(execution.status, "succeeded");
});
