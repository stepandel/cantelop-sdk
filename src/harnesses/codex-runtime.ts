/// <reference types="node" />
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SessionActivationContext,
  SessionBehaviour,
  SessionHarness,
  SessionHarnessContext,
  SessionOutput,
} from "../session.js";
import {
  createCodexHarness,
  type CodexHarnessFactoryOptions,
  type CodexMessage,
  type CodexEvent,
} from "./codex.js";
import {
  CodexStateStore,
  CodexWriterFenced,
  type CodexState,
  type CodexWorkMessage,
} from "./codex-state.js";
import {
  validateCodexSessionSettings,
  type CodexSessionCommand as Command,
  type CodexSessionEvent as Event,
  type CodexSessionReply as Reply,
  type CodexSessionStatus as Status,
  type CodexSessionUpdate as Update,
} from "./codex-protocol.js";

type Activation = SessionActivationContext<Command, Event>;
type Factory = (
  context: SessionHarnessContext,
  options: CodexHarnessFactoryOptions,
) => SessionHarness<CodexMessage, CodexEvent>;
interface ActiveTurn {
  id: string;
  controller: AbortController;
  outcome?: Status;
}
export interface CodexRuntimeOptions
  extends Omit<CodexHarnessFactoryOptions, "conversation"> {
  /** Renewed while a native turn is running. */
  readonly activityTimeoutMs?: number;
}
const messageStatus = (message: CodexWorkMessage): Update => ({
  type: "message.status",
  id: message.id,
  status: message.status,
});

/** Committed intake and observation, with conservative recovery of native execution.
 * A running turn is interrupted after process loss; accepted queued work resumes on every activation.
 */
export function createCodexRuntime(
  options: CodexRuntimeOptions = {},
  factory: Factory = createCodexHarness,
): SessionBehaviour<Command, Event, Reply> {
  const { activityTimeoutMs = 1_800_000, ...defaults } =
    structuredClone(options);
  if (
    !Number.isSafeInteger(activityTimeoutMs) ||
    activityTimeoutMs < 3 ||
    activityTimeoutMs > 86_400_000
  )
    throw new TypeError("Invalid Codex activity timeout");
  const appSettings = validateCodexSessionSettings({
    ...(defaults.model === undefined ? {} : { model: defaults.model }),
    ...(defaults.systemPrompt === undefined
      ? {}
      : { systemPrompt: defaults.systemPrompt }),
  });
  let store: CodexStateStore | undefined;
  let opening: Promise<void> | undefined;
  let resources: Activation | undefined;
  let active: ActiveTurn | undefined;
  let stopped = false;
  let pendingOutput = 0;

  // Live delivery is bounded and never owns execution. A sequence gap is recovered from SQL.
  function publish(output: SessionOutput<Event>, events: Event[]) {
    for (const event of events) {
      if (pendingOutput >= 32) continue;
      pendingOutput++;
      void Promise.resolve()
        .then(() => output.send(event))
        .catch(() => {})
        .finally(() => {
          pendingOutput--;
        });
    }
  }
  function recoverRunning(state: CodexState, safeToRetry?: string): Update[] {
    return state.messages.flatMap((message) => {
      if (message.status !== "running" && !message.outcome) return [];
      message.status =
        message.outcome ??
        (message.id === safeToRetry ? "queued" : "interrupted");
      delete message.outcome;
      if (message.status === "queued") {
        if (!state.queue.includes(message.id)) state.queue.unshift(message.id);
      } else {
        state.queue = state.queue.filter((id) => id !== message.id);
        delete message.settings;
      }
      return [messageStatus(message)];
    });
  }
  async function reopen(output: SessionOutput<Event>, safeToRetry?: string) {
    // Native queue() has settled and cleaned up. Reopen the committed state rather
    // than retrying an ambiguous write; retain activity ownership during an outage.
    for (let wait = 100; ; wait = Math.min(wait * 2, 5_000)) {
      resources!.signal.throwIfAborted();
      try {
        const restored = await store!.reopen(await resources!.database());
        const events = await restored.update((state) =>
          recoverRunning(state, safeToRetry),
        );
        store = restored;
        publish(output, events);
        return;
      } catch (error) {
        if (error instanceof CodexWriterFenced) {
          stopped = true;
          throw error;
        }
        await delay(wait, undefined, { signal: resources!.signal });
      }
    }
  }
  async function open(context: Activation) {
    if (stopped) throw new Error("Codex runtime has stopped");
    if (resources && resources.session.id !== context.session.id)
      throw new Error("Codex runtime belongs to one Session");
    resources ??= context;
    opening ??= (async () => {
      store = await CodexStateStore.open(
        await context.database(),
        context.session.id,
      );
      const events = await store.update((state) => recoverRunning(state));
      publish(context.output, events);
      const stop = () => {
        stopped = true;
        active?.controller.abort(context.signal.reason);
      };
      context.signal.addEventListener("abort", stop, { once: true });
      if (context.signal.aborted) {
        stop();
        throw context.signal.reason;
      }
    })();
    await opening;
  }

  async function drain(context: Activation) {
    if (
      active ||
      context.activity.active ||
      stopped ||
      !store!.state.queue.length
    )
      return;
    const id = store!.state.queue[0]!;
    const controller = new AbortController();
    const current: ActiveTurn = { id, controller };
    active = current;
    context.activity.start(
      async (activity) => {
        const abort = () => {
          current.outcome ??= "interrupted";
          controller.abort(activity.signal.reason);
        };
        activity.signal.addEventListener("abort", abort, { once: true });
        if (activity.signal.aborted) abort();
        const renew = setInterval(
          () => {
            try {
              if (!activity.signal.aborted)
                resources!.activity.extend(activityTimeoutMs);
            } catch (error) {
              controller.abort(error);
            }
          },
          Math.max(1, Math.floor(activityTimeoutMs / 3)),
        );
        renew.unref();
        let outcome: Status = "failed";
        let executionStarted = false;
        try {
          const events = await store!.update((state) => {
            state.queue = state.queue.filter((queued) => queued !== id);
            const message = state.messages.find(
              (message) => message.id === id,
            )!;
            message.status = "running";
            return [messageStatus(message)];
          });
          publish(activity.output, events);
          controller.signal.throwIfAborted();
          const message = store!.state.messages.find(
            (message) => message.id === id,
          )!;
          const native = factory(resources!, {
            ...defaults,
            ...message.settings,
            // Native child agents have no independent durable wake/ownership contract here.
            config: {
              ...defaults.config,
              "features.multi_agent": false,
              "features.multi_agent_v2": false,
            },
            ...(store!.state.threadId === undefined
              ? {}
              : { conversation: { id: store!.state.threadId } }),
          });
          const prompt: CodexMessage = { type: "prompt", prompt: message.text };
          executionStarted = true;
          await native.queue(prompt, {
            ...resources!,
            signal: controller.signal,
            message: { id, sequence: 0, payload: prompt },
            view: activity.view,
            send: (next) =>
              activity.send({
                type: "queue",
                id: randomUUID(),
                text: next.prompt,
              }),
            output: {
              send: async (event) => {
                const json = JSON.stringify(event);
                if (Buffer.byteLength(json) > 4 * 1024 * 1024)
                  throw new Error("Codex event exceeds 4 MiB");
                let updates: Update[];
                if (Buffer.byteLength(json) <= 16 * 1024)
                  updates = [{ type: "codex", id, event }];
                else {
                  const eventId = randomUUID(),
                    total = Math.ceil(json.length / 8192);
                  updates = Array.from({ length: total }, (_, index) => ({
                    type: "codex.fragment",
                    id,
                    eventId,
                    index,
                    total,
                    json: json.slice(index * 8192, (index + 1) * 8192),
                  }));
                }
                const committed = await store!.update((state) => {
                  if (event.method === "thread/started") {
                    const thread = event.params.thread as
                      | { id?: unknown }
                      | undefined;
                    if (typeof thread?.id !== "string" || !thread.id)
                      throw new Error("Invalid Codex thread binding");
                    if (state.threadId && state.threadId !== thread.id)
                      throw new Error("Codex thread binding changed");
                    state.threadId = thread.id;
                  }
                  return updates;
                });
                publish(activity.output, committed);
              },
            },
          });
          outcome = "completed";
        } catch {
          // A native failure is a task outcome. Storage failures are resolved from
          // committed state only after native execution and cleanup have stopped.
          outcome = "failed";
        } finally {
          try {
            try {
              const events = await store!.update((state) => {
                const message = state.messages.find(
                  (message) => message.id === id,
                )!;
                message.status =
                  message.outcome ??
                  current.outcome ??
                  (controller.signal.aborted ? "interrupted" : outcome);
                delete message.settings;
                delete message.outcome;
                return [messageStatus(message)];
              });
              publish(activity.output, events);
            } catch (error) {
              if (error instanceof CodexWriterFenced) {
                stopped = true;
                throw error;
              }
              await reopen(activity.output, executionStarted ? undefined : id);
            }
            active = undefined;
            // Even cancellation drains accepted follow-ups. Lifetime shutdown does not.
            if (!stopped) activity.send({ type: "drain" });
          } finally {
            clearInterval(renew);
            activity.signal.removeEventListener("abort", abort);
          }
        }
      },
      {
        timeoutMs: activityTimeoutMs,
        onCancel: () => {
          current.outcome ??= "cancelled";
          const intent = store!.update((state) => {
            const message = state.messages.find(
              (message) => message.id === id,
            )!;
            if (message.status === "running" || message.status === "queued")
              message.outcome ??= "cancelled";
            return [];
          });
          controller.abort();
          return intent.then(() => {});
        },
      },
    );
  }

  return {
    redelivery: true,
    async onActivate(context) {
      await open(context);
      publish(context.output, [
        { type: "session.ready", sessionId: context.session.id },
      ]);
      await drain(context);
    },
    async receive(context) {
      try {
        await open(context);
        const command = context.message.payload;
        if (!command || typeof command !== "object")
          throw new TypeError("Invalid Codex command");
        if (command.type === "snapshot") {
          const state = store!.state;
          context.reply({
            type: "session.state",
            configured: true,
            cursor: state.cursor,
            ...(state.threadId === undefined
              ? {}
              : { threadId: state.threadId }),
            messages: state.messages.slice(-50).map(({ id, text, status }) => ({
              id,
              text: text.slice(0, 128),
              status,
            })),
            truncated:
              state.messages.length > 50 ||
              state.messages.some((message) => message.text.length > 128),
          });
          return;
        }
        if (command.type === "events") {
          const after = command.after ?? 0,
            limit = command.limit ?? 50;
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100
          )
            throw new TypeError("Invalid Codex event page");
          context.reply({
            type: "session.events",
            ...(await store!.events(after, limit)),
          });
          return;
        }
        if (command.type === "drain") {
          await drain(context);
          return;
        }
        if (
          command.type !== "queue" &&
          command.type !== "steer" &&
          command.type !== "cancel"
        )
          throw new TypeError("Invalid Codex command");
        if (
          typeof command.id !== "string" ||
          !command.id ||
          command.id.length > 128 ||
          Buffer.byteLength(JSON.stringify(command.id)) > 256
        )
          throw new TypeError("Invalid Codex message ID");
        if (command.type === "cancel") {
          if (active?.id === command.id) {
            const current = active;
            await store!.update((state) => {
              const message = state.messages.find(
                (message) => message.id === command.id,
              )!;
              if (message.status === "running" || message.status === "queued")
                message.outcome = "cancelled";
              return [];
            });
            if (active === current) {
              current.outcome = "cancelled";
              current.controller.abort();
            }
          } else {
            const events = await store!.update((state) => {
              const message = state.messages.find(
                (message) => message.id === command.id,
              );
              if (!message || message.status !== "queued") return [];
              message.status = "cancelled";
              delete message.settings;
              state.queue = state.queue.filter((id) => id !== message.id);
              return [messageStatus(message)];
            });
            publish(context.output, events);
          }
          return;
        }
        if (
          typeof command.text !== "string" ||
          !command.text.trim() ||
          Buffer.byteLength(command.text) > 256 * 1024
        )
          throw new TypeError("Invalid Codex prompt");
        const overrides = validateCodexSessionSettings(command.settings ?? {});
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              type: command.type,
              text: command.text,
              ...overrides,
            }),
          )
          .digest("hex");
        const existing = store!.state.messages.find(
          (message) => message.id === command.id,
        );
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new Error("Codex message ID conflict");
          // A retry never interrupts a different task or publishes an uncommitted status.
          await drain(context);
          return;
        }
        const events = await store!.update((state) => {
          if (state.messages.length >= 1000)
            throw new Error("Codex Session full");
          const message: CodexWorkMessage = {
            id: command.id,
            text: command.text,
            fingerprint,
            status: "queued",
            settings: { ...appSettings, ...overrides },
          };
          state.messages.push(message);
          if (command.type === "steer") state.queue.unshift(message.id);
          else state.queue.push(message.id);
          if (command.type === "steer" && active)
            state.messages.find(
              (message) => message.id === active!.id,
            )!.outcome = "steered";
          return [messageStatus(message)];
        });
        // Steering is durable interrupt-then-resume, avoiding an ambiguous in-flight native steer.
        if (command.type === "steer" && active) {
          active.outcome = "steered";
          active.controller.abort();
        }
        publish(context.output, events);
        await drain(context);
      } catch (error) {
        if (store?.failed && !stopped) {
          if (active) active.controller.abort(error);
          else {
            // Intake itself can lose a commit response before a native activity
            // exists. Keep this invocation open until committed work is recovered.
            await reopen(context.output);
            await drain(context);
          }
        }
        throw error;
      }
    },
    async onRecover(context) {
      await open(context);
      await drain(context);
    },
  };
}
