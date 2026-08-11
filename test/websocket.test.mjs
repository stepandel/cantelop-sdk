import assert from "node:assert/strict";
import test from "node:test";
import { createApp, createExecutionEnvironment } from "../dist/index.js";

class FakeSocket {
  protocol = "";
  signal = new AbortController().signal;
  sent = [];
  closed = undefined;

  send(message) {
    this.sent.push(message);
  }

  close(code, reason) {
    this.closed = { code, reason };
  }

  async *messages() {
    yield "hello";
  }
}

test("an app dispatches WebSocket routes", async () => {
  const execution = createExecutionEnvironment(async ({ input }) => input);
  const app = createApp({ execution });

  app.websocket("/socket", async ({ socket }) => {
    for await (const message of socket.messages()) {
      await socket.send(`echo:${message}`);
    }
  });

  const socket = new FakeSocket();
  const handled = await app.handleWebSocket(
    new Request("http://localhost/socket"),
    socket,
  );

  assert.equal(handled, true);
  assert.deepEqual(socket.sent, ["echo:hello"]);
  assert.equal(
    await app.handleWebSocket(
      new Request("http://localhost/missing"),
      new FakeSocket(),
    ),
    false,
  );
});
