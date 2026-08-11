import assert from "node:assert/strict";
import test from "node:test";
import {
  createExecutionEnvironment,
  eventStreamResponse,
} from "../dist/index.js";

test("an execution exposes emitted harness events", async () => {
  const environment = createExecutionEnvironment(async ({ input, emit }) => {
    emit({ type: "delta", value: input.slice(0, 2) });
    emit({ type: "delta", value: input.slice(2) });
    return input.toUpperCase();
  });

  const execution = environment.start("hello");
  const events = [];
  for await (const event of execution.events()) events.push(event);

  assert.deepEqual(events, [
    { type: "delta", value: "he" },
    { type: "delta", value: "llo" },
  ]);
  assert.equal(await execution.wait(), "HELLO");
  assert.equal(execution.status, "succeeded");
});

test("eventStreamResponse streams events as SSE", async () => {
  async function* events() {
    yield { type: "delta", value: "hello" };
    yield { type: "done" };
  }

  const response = eventStreamResponse(events(), {
    eventName: (event) => event.type,
  });

  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(
    await response.text(),
    'event: delta\ndata: {"type":"delta","value":"hello"}\n\n' +
      'event: done\ndata: {"type":"done"}\n\n',
  );
});
