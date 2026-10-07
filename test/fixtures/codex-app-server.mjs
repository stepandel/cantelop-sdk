// Protocol fixture only. This is not a native harness or proof of full storage coverage.
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { CODEX_WORKSPACE_STORAGE_DOMAINS } from "../../dist/codex.js";

const mode = process.env.CODEX_FIXTURE_MODE ?? "success";
const capabilities = {
  protocolVersion: 1, backend: "workspace", localSqlite: false,
  domains: mode === "partial" ? ["threads"] : CODEX_WORKSPACE_STORAGE_DOMAINS,
};
if (process.argv.includes("--cantelop-storage-probe")) {
  if (mode === "stock") process.exit(2);
  console.log(JSON.stringify(capabilities));
  process.exit(0);
}
if (process.env.CODEX_FIXTURE_STARTED) await writeFile(process.env.CODEX_FIXTURE_STARTED, "started");
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const storage = async params => {
  const response = await fetch(process.env.CANTELOP_CODEX_STORAGE_URL, {
    method: "POST", headers: { authorization: `Bearer ${process.env.CANTELOP_CODEX_STORAGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error("fixture storage error");
  return response.json();
};
await storage({ operation: "execute", statement: { sql: "CREATE TABLE IF NOT EXISTS codex_fixture_threads (id TEXT PRIMARY KEY, prompt TEXT)" } });
const reader = createInterface({ input: process.stdin });
let threadSequence = 0;
reader.on("line", line => {
  void handle(JSON.parse(line)).catch(() => process.exit(3));
});
async function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, { userAgent: "fixture", cantelopWorkspaceStorage: mode === "bad-handshake" ? {} : capabilities });
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "thread/start") {
    const id = `thread-${process.pid}-${++threadSequence}`;
    await storage({ operation: "execute", statement: {
      sql: "INSERT INTO codex_fixture_threads (id) VALUES (?)", args: [{ type: "text", value: id }],
    } });
    reply(message.id, { thread: { id } });
  } else if (message.method === "thread/resume") {
    const result = await storage({ operation: "execute", statement: {
      sql: "SELECT id FROM codex_fixture_threads WHERE id = ?", args: [{ type: "text", value: message.params.threadId }],
    } });
    if (!result.rows.length) send({ id: message.id, error: { code: -1, message: "thread missing" } });
    else reply(message.id, { thread: { id: message.params.threadId } });
  } else if (message.method === "turn/start") {
    const { threadId, input } = message.params;
    await storage({ operation: "execute", statement: {
      sql: "UPDATE codex_fixture_threads SET prompt = ? WHERE id = ?",
      args: [{ type: "text", value: input[0].text }, { type: "text", value: threadId }],
    } });
    const turn = { id: "turn-1", status: "inProgress" };
    // Exercise notifications emitted before the turn/start response.
    event("turn/started", { threadId, turn });
    event("item/agentMessage/delta", { threadId, turnId: turn.id, delta: "Hello" });
    reply(message.id, { turn });
    if (mode === "disconnect") process.exit(0);
    if (mode !== "wait") event("turn/completed", { threadId, turn: { ...turn, status: mode === "failed-turn" ? "failed" : "completed" } });
  } else if (message.method === "turn/interrupt") {
    if (message.params.turnId !== "turn-1") throw new Error("missing turn ID");
    if (process.env.CODEX_FIXTURE_INTERRUPTED) await writeFile(process.env.CODEX_FIXTURE_INTERRUPTED, message.params.turnId);
    reply(message.id, {});
    event("turn/completed", { threadId: message.params.threadId, turn: { id: "turn-1", status: "interrupted" } });
  } else if (message.method === "turn/steer") {
    reply(message.id, { turnId: message.params.expectedTurnId });
  } else if (message.method === "cantelop/shutdown") {
    reply(message.id, {});
  } else if (message.method === "test/no-reply") {
    return;
  } else if (message.method === "test/server-request") {
    send({ id: "server-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread" } });
    reply(message.id, {});
  } else if (message.id === "server-1" && !message.method) {
    event("test/server-response", { response: message });
  } else if (message.method === "test/malformed") {
    process.stdout.write("{bad json}\n");
  } else {
    send({ id: message.id, error: { code: -32601, message: "secret SQL error: token=value" } });
  }
}
