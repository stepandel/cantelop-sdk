import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  createApp,
  createExecutionEnvironment,
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
  const execution = createExecutionEnvironment(async () => undefined);
  const app = createApp({ execution });
  app.route("GET", "/stream", () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("one"));
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(encoder.encode("two"));
          controller.close();
        },
      }),
    );
  });

  await withServer(app, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      "onetwo",
    );
  });
});
