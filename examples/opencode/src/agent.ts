import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

export async function create(context: SessionHarnessContext): Promise<SessionHarness<SessionMessage, SessionEvent>> {
  context.signal.throwIfAborted();
  // One stock server and native session per runtime incarnation, shared by all turns.
  const server = await createOpencodeServer({
    hostname: "127.0.0.1", port: 0, signal: context.signal, timeout: 30_000,
    ...(context.env.OPENCODE_MODEL ? { config: { model: context.env.OPENCODE_MODEL } } : {}),
  });
  try {
    const client = createOpencodeClient({ baseUrl: server.url, directory: process.cwd() });
    const { data } = await client.session.create(
      { title: `Cantelop ${context.session.id}` }, { signal: context.signal, throwOnError: true },
    );
    return wrapOpenCode(client, data.id);
  } catch (error) {
    server.close();
    throw error;
  }
}

/** Wrap an existing client/session; server startup and configuration stay with the caller. */
export function wrapOpenCode(client: OpencodeClient, sessionID: string): SessionHarness<SessionMessage, SessionEvent> {
  return {
    async run(message, { signal, output }) {
      signal.throwIfAborted();
      // Keep this native request alive through cancellation so it reaches its
      // actual completion boundary. Cancelling an HTTP read alone cannot stop work.
      const { data } = await client.session.prompt(
        { sessionID, parts: [{ type: "text", text: message.prompt }] },
        { throwOnError: true },
      );
      signal.throwIfAborted();
      if (data.info.error) throw new Error(JSON.stringify(data.info.error));
      await output.send(data);
    },
    async cancel() {
      await client.session.abort({ sessionID }, { signal: AbortSignal.timeout(5_000), throwOnError: true });
    },
  };
}
