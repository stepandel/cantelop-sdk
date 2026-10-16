import { createClient } from "@libsql/client";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexRuntime } from "../../dist/harnesses/codex.js";

const [root, mode] = process.argv.slice(2);
const db = createClient({ url: `file:${join(root, "crash.sqlite")}` });
let busy = false,
  mailbox = Promise.resolve(),
  reply,
  effectCommitted = false;
const controller = new AbortController();
const runtime = createCodexRuntime({}, () => ({
  async queue(message, work) {
    await work.output.send({
      method: "thread/started",
      params: { thread: { id: "persistent-thread" } },
    });
    await appendFile(join(root, "effects"), `${message.prompt}\n`, {
      flush: true,
    });
    effectCommitted = true;
    if (mode === "crash") await new Promise(() => {});
  },
  steer() {},
  cancel() {
    return false;
  },
}));
const context = {
  signal: controller.signal,
  session: { id: "crash-session" },
  env: {},
  database: async () => db,
  output: { send: async () => {} },
  view: { commit: async () => {} },
  send: async (payload) => {
    void send(payload);
  },
  activity: {
    get active() {
      return busy;
    },
    extend() {},
    start(work) {
      busy = true;
      const pending = [];
      void work({
        signal: controller.signal,
        output: context.output,
        view: context.view,
        send: (payload) => pending.push(payload),
      })
        .then(() => {
          busy = false;
          for (const payload of pending) void send(payload);
        })
        .catch((error) => {
          console.error(error);
          process.exit(1);
        });
    },
  },
};
function send(payload) {
  return (mailbox = mailbox.then(() =>
    runtime.receive({
      ...context,
      command: { type: "dispatch" },
      message: { id: payload.id ?? "internal", sequence: 1, payload },
      reply: (value) => {
        reply = value;
      },
    }),
  ));
}
await runtime.onActivate(context);
if (mode === "crash") {
  await send({ type: "queue", id: "unsafe", text: "unsafe" });
  // Wait for the effect, rather than testing only the pre-execution admission boundary.
  while (!effectCommitted)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await send({ type: "queue", id: "pending", text: "pending" });
  console.log("ADMITTED");
  setInterval(() => {}, 1000);
} else {
  while (busy) await new Promise((resolve) => setTimeout(resolve, 5));
  await send({ type: "snapshot" });
  console.log(JSON.stringify(reply));
  db.close();
}
