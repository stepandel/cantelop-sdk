import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  createApp,
  createExecutionEnvironment,
  eventStreamResponse,
} from "../dist/index.js";
import { serve } from "../dist/node.js";

async function withServer(app, run) {
  const server = serve(app, { port: 0, hostname: "127.0.0.1" });
  await once(server, "listening");
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await run(address.port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("the Node adapter streams response bodies", async () => {
  const execution = createExecutionEnvironment(async ({ emit }) => {
    emit({ type: "delta", value: "one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    emit({ type: "delta", value: "two" });
  });
  const app = createApp({ execution });
  app.route("GET", "/stream", ({ execution }) => {
    const run = execution.start(undefined);
    return eventStreamResponse(run.events());
  });

  await withServer(app, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      'data: {"type":"delta","value":"one"}\n\n' +
        'data: {"type":"delta","value":"two"}\n\n',
    );
  });
});
