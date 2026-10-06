import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  SessionBehaviour,
  SessionEnvironment,
  SessionActivity,
  SessionContext,
  SessionRecoveryContext,
} from "./session.js";
import type { SessionIdentity } from "./resources.js";
import { createSessionDatabase } from "./session-database.js";
import { borrowWorkspaceDatabase, type WorkspaceDatabase } from "./database.js";
import { DurableMailbox } from "./durable-mailbox.js";
import {
  TursoMailboxStore,
  MailboxError,
  type MailboxOwnership,
  type MailboxIdleReceipt,
} from "./mailbox-store.js";
import { InMemoryActivity } from "./activity.js";
import { RuntimeObservationBuffer, RuntimeObserver } from "./observability.js";
import { SessionOutputBuffer } from "./output.js";
import { runWithRuntimeLogContext } from "./runtime-log-capture.js";
import {
  handleOutputRequest,
  handleObservationRequest,
  readRequestEnvelope,
  readSession,
  writeJSON,
  writeError,
} from "./session-runtime-server.js";

export function createDurableSessionRuntime<Input, Event, Reply>(
  behaviour: SessionBehaviour<Input, Event, Reply>,
  options: {
    sandboxId: string;
    env: SessionEnvironment;
    database?: WorkspaceDatabase;
  },
) {
  const db = options.database ?? createSessionDatabase(options.env);
  // An injected client is shared with the mailbox store, so application code only borrows it.
  const applicationClient = () => borrowWorkspaceDatabase(db);
  let applicationDatabase = applicationClient();
  const database = async () => {
    if (applicationDatabase.closed) applicationDatabase = applicationClient();
    await applicationDatabase.credentials();
    return applicationDatabase;
  };
  const store = new TursoMailboxStore(db);
  const outputBuffer = new SessionOutputBuffer();
  const observationBuffer = new RuntimeObservationBuffer();
  let session: SessionIdentity | undefined;
  let mailbox: DurableMailbox | undefined;
  let receipt: MailboxIdleReceipt | undefined;
  let recovering = false;
  let preparing = false;
  let generation = 0;
  let ownership: MailboxOwnership | undefined;
  let recoveryDeadline: number | undefined;
  const recoveryMessages = new Map<string, string>();
  const recoveries = new Map<
    string,
    Promise<{ recovery_id: string; state: string; generation: number }>
  >();
  const send = async (payload: Input): Promise<void> => {
    if (!session || !mailbox) throw new MailboxError("session_unbound");
    await mailbox.enqueue({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      sessionId: session.id,
      payload,
      keepAliveSeconds: session.keepAliveSeconds,
    });
  };
  const activity = new InMemoryActivity<Input, Event>(
    send,
    (id, event, signal) =>
      outputBuffer.publish(
        id,
        event,
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      ),
  );
  const activityCapability: SessionActivity<Input, Event> = {
    get active() {
      return activity.active;
    },
    start(work, policy) {
      activity.start(currentMessage, work, policy);
    },
    extend(timeout) {
      activity.extend(timeout);
    },
    cancel(reason) {
      return activity.cancel(reason);
    },
  };
  let currentMessage = "";
  const lifetime = new AbortController();
  let activation: Promise<void> | undefined;
  const activate = (messageId: string): Promise<void> => {
    if (!behaviour.onActivate) return Promise.resolve();
    activation ??= Promise.resolve().then(() => behaviour.onActivate!({
      signal: lifetime.signal, session: session!, env: options.env, database,
      activity: activityCapability,
      output: { send: (event) => outputBuffer.publish(messageId, event, AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)])) },
      send,
    })).catch((error: unknown) => { activation = undefined; throw error; });
    return activation;
  };
  const bind = (identity: SessionIdentity) => {
    if (
      session &&
      (session.id !== identity.id ||
        session.workspaceId !== identity.workspaceId)
    )
      throw new MailboxError("session_mismatch");
    if (session) return;
    session = identity;
    mailbox = new DurableMailbox(
      store,
      identity.id,
      async (message, signal) => {
        generation++;
        currentMessage = message.id;
        const observer = new RuntimeObserver(
          message.id,
          undefined,
          observationBuffer,
        );
        let open = true;
        let replied = false;
        let replyValue: unknown;
        const context: SessionContext<Input, Event, Reply> = {
          signal,
          message: {
            id: message.id,
            sequence: message.sequence,
            payload: message.payload as Input,
          },
          session: session!,
          env: options.env,
          database,
          activity: {
            ...activityCapability,
            get active() {
              return activity.active;
            },
            start(work, policy) {
              if (!open) throw new MailboxError("invocation_settled");
              activityCapability.start(work, policy);
            },
          },
          output: {
            send: async (event) => {
              if (!open) throw new MailboxError("invocation_settled");
              await outputBuffer.publish(
                message.id,
                event,
                AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              );
            },
          },
          send: async (payload) => {
            if (!open) throw new MailboxError("invocation_settled");
            await send(payload);
          },
          reply(value) {
            if (!open || replied) throw new MailboxError("invalid_reply");
            const encoded = JSON.stringify(value);
            if (encoded === undefined || Buffer.byteLength(encoded) > 65536)
              throw new MailboxError("reply_capacity");
            replied = true;
            replyValue = JSON.parse(encoded);
          },
        };
        try {
          await runWithRuntimeLogContext(observer, () =>
            activate(message.id).then(() => {
              signal.throwIfAborted();
              return observer.span("session.receive", () => behaviour.receive(context));
            }),
          );
        } finally {
          open = false;
        }
        if (message.replyRequested && !replied)
          throw new MailboxError("reply_unavailable");
        return replied ? { reply: replyValue } : {};
      },
      () => {},
      250,
      () => !recovering && activity.isIdle,
    );
  };
  const process = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Cantelop-Sandbox-ID", options.sandboxId);
    response.setHeader("X-Cantelop-Message-Protocol", "2");
    if (request.headers["x-cantelop-sandbox-id"] !== options.sandboxId)
      throw new MailboxError("sandbox_mismatch");
    const url = new URL(request.url ?? "/", "http://runtime.cantelop.internal");
    const path = url.pathname;
    if (path === "/__cantelop/v2/runtime" && request.method === "GET") {
      writeJSON(response, 200, {
        sandbox_id: options.sandboxId,
        protocol: 2,
        generation,
        ownership: ownership ?? null,
        local_idle: !!mailbox?.isIdle && !recovering && activity.isIdle,
        message_work: recovering
          ? { deadline: new Date(recoveryDeadline!).toISOString() }
          : (mailbox?.work() ?? null),
        quiescent: !!receipt && !recovering && activity.isIdle,
        activity: activity.snapshot(),
        capabilities: {
          recovery: !!behaviour.onRecover,
          replies: true,
          durable_mailbox: true,
          redelivery: behaviour.redelivery === true,
        },
        observations: observationBuffer.metadata(),
        events: outputBuffer.metadata(),
        park: receipt ?? null,
      });
      return;
    }
    if (path === "/__cantelop/v2/runtime/resume" && request.method === "POST") {
      const body = (await readRequestEnvelope(request)) as {
        session: unknown;
        ownership: MailboxOwnership;
      };
      const owner = body?.ownership;
      if (
        !owner ||
        owner.sandboxId !== options.sandboxId ||
        !Number.isSafeInteger(owner.epoch) ||
        owner.epoch < 1 ||
        typeof owner.leaseId !== "string"
      )
        throw new MailboxError("invalid_ownership");
      bind(readSession(body.session));
      if (
        owner.sessionId !== session!.id ||
        recovering ||
        preparing ||
        !activity.isIdle
      )
        throw new MailboxError("runtime_busy");
      if (
        ownership?.epoch === owner.epoch &&
        ownership.leaseId === owner.leaseId &&
        !receipt
      ) {
        writeJSON(response, 200, { resumed: true });
        return;
      }
      // The coordinator has already acquired the lease and committed this ownership.
      await mailbox!.resume(owner);
      ownership = { ...owner };
      receipt = undefined;
      writeJSON(response, 200, { resumed: true });
      return;
    }
    if (
      path === "/__cantelop/v2/runtime/prepare-idle" &&
      request.method === "POST"
    ) {
      if (
        !mailbox ||
        recovering ||
        !activity.isIdle ||
        (!mailbox.isIdle && !mailbox.isParked)
      )
        throw new MailboxError("runtime_busy");
      if (preparing) throw new MailboxError("runtime_busy");
      preparing = true;
      try {
        receipt = await mailbox.prepareIdle(AbortSignal.timeout(8000));
        writeJSON(response, 200, receipt);
      } finally {
        preparing = false;
      }
      return;
    }
    if (
      path === "/__cantelop/v2/runtime/recoveries" &&
      request.method === "POST"
    ) {
      const body = (await readRequestEnvelope(request)) as {
        recovery_id: string;
        message_id: string;
        session: unknown;
      };
      if (
        !/^rcv_[0-9a-f]{32}$/.test(body?.recovery_id) ||
        !/^msg_[0-9a-f]{32}$/.test(body?.message_id) ||
        !behaviour.onRecover
      )
        throw new MailboxError("recovery_unsupported");
      bind(readSession(body.session));
      if (
        recoveryMessages.has(body.recovery_id) &&
        recoveryMessages.get(body.recovery_id) !== body.message_id
      )
        throw new MailboxError("recovery_conflict");
      let result = recoveries.get(body.recovery_id);
      if (!result) {
        if (recovering || preparing || !activity.isIdle)
          throw new MailboxError("runtime_busy");
        // Check durable authorization; an old/stale recovery request may never execute.
        const authorization = await db.execute({
          sql: "SELECT 1 FROM cantelop_mailbox_sessions WHERE session_id=? AND sandbox_id=? AND owner_state='recovering' AND recovery_id=? AND recovery_message_id=?",
          args: [
            session!.id,
            options.sandboxId,
            body.recovery_id,
            body.message_id,
          ],
        });
        if (!authorization.rows.length)
          throw new MailboxError("mailbox_ownership_lost");
        recovering = true;
        recoveryDeadline = Date.now() + 300_000;
        currentMessage = body.message_id;
        generation++;
        result = (async () => {
          const signal = AbortSignal.timeout(300_000);
          let open = true;
          const context: SessionRecoveryContext<Input, Event> = {
            signal,
            recovery: {
              id: body.recovery_id,
              interruptedMessageId: body.message_id,
            },
            database,
            session: session!,
            env: options.env,
            activity: {
              ...activityCapability,
              get active() {
                return activity.active;
              },
              start(work, policy) {
                if (!open) throw new MailboxError("invocation_settled");
                activityCapability.start(work, policy);
              },
            },
            output: {
              send: async (event) => {
                if (!open) throw new MailboxError("invocation_settled");
                await outputBuffer.publish(
                  body.message_id,
                  event,
                  AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                );
              },
            },
            send: async (payload) => {
              if (!open) throw new MailboxError("invocation_settled");
              await send(payload);
            },
          };
          try {
            await activate(body.message_id);
            signal.throwIfAborted();
            await behaviour.onRecover!(context);
            return {
              recovery_id: body.recovery_id,
              state: "completed",
              generation,
            };
          } catch {
            return {
              recovery_id: body.recovery_id,
              state: "failed",
              generation,
            };
          } finally {
            open = false;
            recovering = false;
          }
        })();
        recoveryMessages.set(body.recovery_id, body.message_id);
        recoveries.set(body.recovery_id, result);
      }
      writeJSON(response, 200, await result);
      return;
    }
    if (
      path === "/__cantelop/v2/runtime/activity/cancel" &&
      request.method === "POST"
    ) {
      const body = (await readRequestEnvelope(request)) as {
        activity_id: string;
      };
      if (activity.snapshot()?.id !== body.activity_id)
        throw new MailboxError("activity_mismatch");
      activity.cancel();
      writeJSON(response, 200, { active: activity.active });
      return;
    }
    for (const [base, buffer] of [
      ["/__cantelop/v2/runtime/events", outputBuffer],
      ["/__cantelop/v2/runtime/observations", observationBuffer],
    ] as const) {
      if (path === base + "/ack" && request.method === "POST") {
        const body = (await readRequestEnvelope(request)) as {
          through: number;
        };
        buffer.acknowledge(body.through);
        writeJSON(response, 200, buffer.metadata());
        return;
      }
    }
    if (path === "/__cantelop/v2/runtime/events") {
      await handleOutputRequest(request, response, url, outputBuffer);
      return;
    }
    if (path === "/__cantelop/v2/runtime/observations") {
      await handleObservationRequest(request, response, url, observationBuffer);
      return;
    }
    writeError(response, 404, "runtime_route_not_found");
  };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void process(request, response).catch((error) => {
      if (response.destroyed || response.writableEnded) return;
      const code =
        error instanceof MailboxError
          ? error.code
          : error instanceof RangeError
            ? error.message
            : "runtime_unavailable";
      writeError(
        response,
        error instanceof MailboxError
          ? 409
          : error instanceof RangeError
            ? 409
            : 503,
        code,
      );
    });
  };
  return {
    handler,
    observationBuffer,
    closeDatabase: async () => {
      try {
        lifetime.abort();
        await mailbox?.close();
      } finally {
        db.close();
        applicationDatabase.close();
      }
    },
  };
}
