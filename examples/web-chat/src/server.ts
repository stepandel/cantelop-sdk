import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { CantelopClient, AppConfigurationError, RemoteAppError } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.js";

const assets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/chat.js", { file: "chat.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);

/** Application-owned HTTP routes; these are not Cantelop Edge handlers. */
export function createChatServer(cantelop: CantelopClient<ChatMessage, ChatEvent>, workspaceSlug = "web-chat-demo") {
  const workspace = cantelop.workspace({ slug: workspaceSlug });
  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "/", "http://localhost");
    const asset = assets.get(url.pathname);
    if (request.method === "GET" && asset) {
      response.setHeader("Content-Type", asset.type);
      response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      response.end(await readFile(new URL(`../public/${asset.file}`, import.meta.url)));
      return;
    }
    if (url.pathname !== "/api/chat") { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") { response.writeHead(415).end(); return; }
    // This localhost example has one server-owned Workspace. Browser input selects
    // only a conversation, never an App, Workspace or integration credential.
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) { response.writeHead(403).end(); return; }
    let input: { sessionId: string; messageId: string; prompt: string };
    try { input = await readInput(request); }
    catch { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_chat_message" })); return; }

    const controller = new AbortController();
    const disconnected = () => controller.abort();
    response.on("close", disconnected);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const session = workspace.session({ id: input.sessionId, keepAliveSeconds: 300 });
      const message = await session.dispatch({ type: "prompt", prompt: input.prompt }, { id: input.messageId, signal: controller.signal });
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      await write({ type: "accepted", messageId: message.id });
      // The Edge must replay retained output when no cursor is supplied. Filtering
      // the admission ID excludes earlier turns, including output sent before subscribe.
      for await (const event of session.stream({ signal: controller.signal })) {
        if (event.messageId !== message.id) continue;
        if (event.data.type === "text_delta" && typeof event.data.delta === "string") {
          await write({ type: "text_delta", delta: event.data.delta });
        } else if (event.data.type === "done" && typeof event.data.answer === "string") {
          await write({ type: "done", answer: event.data.answer });
          return;
        }
      }
      throw new Error("Output ended before the final answer");
    } catch (error) {
      if (response.destroyed) return;
      const code = error instanceof AppConfigurationError || error instanceof RemoteAppError ? error.code
        : controller.signal.aborted ? "chat_timeout" : "chat_stream_failed";
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      response.write(JSON.stringify({ type: "error", code, messageId: input.messageId }) + "\n");
    } finally {
      clearTimeout(timeout);
      response.off("close", disconnected);
      controller.abort(); // Close this subscription; do not cancel admitted work.
      response.end();
    }

    async function write(value: unknown) {
      controller.signal.throwIfAborted();
      if (!response.write(JSON.stringify(value) + "\n")) await once(response, "drain", { signal: controller.signal });
    }
  }
}

async function readInput(request: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size <= 16_384) parts.push(bytes);
  }
  if (size > 16_384) throw new Error("Body too large");
  const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["sessionId", "messageId", "prompt"].includes(key)) ||
      typeof value.sessionId !== "string" || !/^ses_[0-9a-f]{32}$/.test(value.sessionId) ||
      typeof value.messageId !== "string" || !/^msg_[0-9a-f]{32}$/.test(value.messageId) ||
      typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 4000) throw new Error("Invalid message");
  return { sessionId: value.sessionId as string, messageId: value.messageId as string, prompt: value.prompt.trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cantelop = new CantelopClient<ChatMessage, ChatEvent>();
  const server = createChatServer(cantelop, process.env.CHAT_WORKSPACE_SLUG ?? "web-chat-demo");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.listen(port, "127.0.0.1", () => console.log(`Chat: http://127.0.0.1:${port}`));
}
