import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import { defineSessionBehaviour, type SessionContext } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;
let conversationId: string | undefined;
const promptQueue: string[] = [];

export default defineSessionBehaviour<SessionMessage, SessionEvent>((context) => {
  const command = context.message.payload;
  if (command.type === "cancel") {
    promptQueue.length = 0;
    context.activity.cancel();
    return;
  }
  if (context.activity.active) {
    // OpenCode steering is queued here, just like the OpenAI example.
    promptQueue.push(command.prompt);
    return;
  }
  if (!context.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  context.activity.start(async ({ signal, output, send }) => {
    // A server belongs to this activity; its local database survives between
    // turns in the same Sandbox. Do not put the live database on Workspace NFS.
    let server: Awaited<ReturnType<typeof createOpencodeServer>> | undefined;
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    const streamController = new AbortController();
    const streamSignal = AbortSignal.any([signal, streamController.signal]);
    try {
      signal.throwIfAborted();
      server = await createOpencodeServer({
        hostname: "127.0.0.1",
        port: 0,
        timeout: 30_000,
        config: {
          model: context.env.OPENCODE_MODEL ?? "anthropic/claude-sonnet-4-5",
          share: "disabled",
          permission: {
            "*": "allow",
            external_directory: "deny",
            question: "deny",
            doom_loop: "deny",
          },
        },
      });
      signal.throwIfAborted();
      client = createOpencodeClient({ baseUrl: server.url, directory: process.cwd() });
      if (conversationId === undefined) {
        const { data } = await client.session.create(
          { title: `Cantelop ${context.session.id}` },
          { signal, throwOnError: true },
        );
        conversationId = data.id;
      }
      const sessionID = conversationId;
      const assistantMessages = new Set<string>();
      const textParts = new Map<string, string>();
      let submitted = false;
      let completed = false;
      // subscribe() is lazy: wait for server.connected before sending the prompt
      // so a fast response cannot finish before the event connection is open.
      const handshakeTimeout = setTimeout(() => streamController.abort(
        new Error("OpenCode event subscription timed out"),
      ), 15_000);
      try {
        const events = await client.event.subscribe({}, {
          signal: streamSignal,
          sseMaxRetryAttempts: 1,
        });
        for await (const event of events.stream) {
          if (event.type === "server.connected" && !submitted) {
            clearTimeout(handshakeTimeout);
            await client.session.promptAsync({
              sessionID,
              parts: [{ type: "text", text: command.prompt }],
            }, { signal, throwOnError: true });
            submitted = true;
          } else if (event.type === "message.updated") {
            const { info } = event.properties;
            if (info.sessionID !== sessionID || info.role !== "assistant") continue;
            assistantMessages.add(info.id);
            if (info.error) throw new Error(JSON.stringify(info.error));
          } else if (event.type === "message.part.updated") {
            const { part } = event.properties;
            if (part.sessionID !== sessionID || part.type !== "text" ||
                !assistantMessages.has(part.messageID)) continue;
            const previous = textParts.get(part.id) ?? "";
            textParts.set(part.id, part.text);
            if (part.text.startsWith(previous) && part.text.length > previous.length) {
              await output.send({ type: "text_delta", delta: part.text.slice(previous.length) });
            }
          } else if (event.type === "message.part.delta") {
            const part = event.properties;
            if (part.sessionID !== sessionID || part.field !== "text" ||
                !textParts.has(part.partID)) continue;
            textParts.set(part.partID, textParts.get(part.partID)! + part.delta);
            await output.send({ type: "text_delta", delta: part.delta });
          } else if (event.type === "session.error" && event.properties.sessionID === sessionID) {
            throw new Error(JSON.stringify(event.properties.error));
          } else if (event.type === "session.idle" &&
                     event.properties.sessionID === sessionID && submitted) {
            signal.throwIfAborted();
            await output.send({ type: "done", answer: [...textParts.values()].join("\n") });
            completed = true;
            break;
          }
        }
        if (!completed && !signal.aborted) {
          throw streamSignal.reason ?? new Error("OpenCode event stream ended before completion");
        }
      } finally {
        clearTimeout(handshakeTimeout);
      }
    } catch (error) {
      if (!signal.aborted) {
        await output.send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      streamController.abort();
      // An aborted HTTP subscription does not stop the agent. Abort remotely
      // before closing its server, including on stream or output failures.
      if (client && conversationId) {
        await client.session.abort({ sessionID: conversationId }, {
          signal: AbortSignal.timeout(5_000),
          throwOnError: true,
        }).catch(() => undefined);
      }
      server?.close();
      const nextPrompt = promptQueue.shift();
      // cancel already cleared older work; a prompt accepted during cleanup
      // still belongs to the next turn.
      if (nextPrompt !== undefined) {
        send({ type: "prompt", prompt: nextPrompt });
      }
    }
  });
});
