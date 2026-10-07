/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, AttachedReplicatedState } from "@earendil-works/chord";
import {
  Harness,
  type HarnessOptions,
  type ToolRegistration,
  type Conversation,
  type ConversationId,
  type SubmissionDraft,
  type SubmissionId,
  type TaskId,
  type TaskGraph,
  type AgentChange,
} from "@earendil-works/pi-durable";
import {
  defineSessionBehaviour,
  type SessionBehaviour,
  type SessionActivationContext,
  type SessionContext,
} from "../session.js";
import type { WorkspaceDatabase } from "../database.js";
import { openPiDurableStorage } from "./storage.js";
import { encodePiDurableUpdate, type PiDurableEvent } from "./events.js";

export interface PiDurableHarnessOptions<
  Tool extends ToolRegistration = ToolRegistration,
> {
  readonly database: WorkspaceDatabase;
  readonly sessionId: string;
  readonly harness: HarnessOptions<Tool>;
}

/** Full upstream Harness, backed by the Session's logical store in its Workspace DB. */
export async function openPiDurableHarness<Tool extends ToolRegistration>(
  options: PiDurableHarnessOptions<Tool>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Harness> {
  const storage = await openPiDurableStorage(
    options.database,
    options.sessionId,
    context,
  );
  return Harness.open(storage, options.harness, context);
}

export type PiDurableMessage =
  | (SubmissionDraft & { readonly conversationId?: ConversationId })
  | { readonly type: "abortSubmission"; readonly submissionId: SubmissionId }
  | { readonly type: "abortTask"; readonly taskId: TaskId }
  | { readonly type: "snapshot"; readonly conversationId?: ConversationId }
  | { readonly type: "resume" };

export type PiDurableReply =
  | {
      readonly type: "submitted";
      readonly conversationId: ConversationId;
      readonly submissionId: SubmissionId;
    }
  | {
      readonly type: "abort-requested";
      readonly target: "submission" | "task";
      readonly id: number;
    }
  | { readonly type: "snapshot"; readonly conversationId: ConversationId }
  | { readonly type: "resumed" };

type Activation = SessionActivationContext<PiDurableMessage, PiDurableEvent>;
type Intake = SessionContext<PiDurableMessage, PiDurableEvent, PiDurableReply>;

export interface PiDurableSessionOptions<
  Tool extends ToolRegistration = ToolRegistration,
> {
  readonly harness:
    | HarnessOptions<Tool>
    | ((
        context: Activation,
      ) => HarnessOptions<Tool> | Promise<HarnessOptions<Tool>>);
  readonly agent?: AgentChange;
  /** Full Harness access for application initialization, documents, conversations and tools. */
  readonly onOpen?: (
    harness: Harness,
    context: Activation,
  ) => void | Promise<void>;
  /** Renewed while ANY Pi task is live, including sleeping, blocked and background tasks. */
  readonly activityTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface Opened {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly graph: AttachedReplicatedState<TaskGraph>;
  readonly dispose: () => void;
}

/**
 * Durable intake plus supervised execution. Handler completion means Pi admitted input,
 * not that the model answered. Pi's task graph owns all execution/replay decisions.
 */
export function definePiDurableSession<
  Tool extends ToolRegistration = ToolRegistration,
>(
  options: PiDurableSessionOptions<Tool>,
): SessionBehaviour<PiDurableMessage, PiDurableEvent, PiDurableReply> {
  const timeout = options.activityTimeoutMs ?? 1_800_000;
  if (!Number.isSafeInteger(timeout) || timeout < 3 || timeout > 86_400_000)
    throw new TypeError("Pi activity timeout must be between 3ms and 24h");
  let opening: Promise<Opened> | undefined;
  let opened: Opened | undefined;
  let latest: Activation | undefined;
  let sessionId: string | undefined;
  let halted = false;
  // Runtime shutdown is final; a halted execution reopens on the next intake.
  let stopped = false;
  let lifetime: AbortSignal | undefined;
  let closing: Promise<void> = Promise.resolve();
  let inFlight = 0;
  let running = false;
  let liveSnapshot: (() => Promise<void>) | undefined;
  let observationReady: Promise<void> | undefined;
  let revision = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    revision++;
    for (const listener of [...listeners]) listener();
  };
  const report = (error: unknown) => {
    try {
      if (options.onError) options.onError(error);
      else console.error("Cantelop Pi Durable execution failed", error);
    } catch {
      /* Reporting must not change ownership or execution. */
    }
  };
  const busy = () =>
    inFlight > 0 ||
    (opened !== undefined && Object.keys(opened.graph.value.tasks).length > 0);

  async function open(context: Activation): Promise<Opened> {
    if (stopped) throw new Error("Pi Session runtime has stopped");
    if (halted) {
      if (running) throw new Error("Pi Session execution is stopping; retry");
      // The failed execution disposed and closed its harness. Reopening fences it and
      // resolves any ambiguous commit from the persisted log.
      halted = false;
      opened = undefined;
      opening = undefined;
    }
    if (sessionId !== undefined && sessionId !== context.session.id)
      throw new Error("A Pi Session behaviour belongs to one runtime Session");
    sessionId = context.session.id;
    latest = context;
    opening ??= (async () => {
      await closing.catch(() => {});
      // Shutdown follows the runtime incarnation, not the Message that reopened it.
      const signal = lifetime ?? context.signal;
      const harnessOptions =
        typeof options.harness === "function"
          ? await options.harness(context)
          : options.harness;
      const harness = await openPiDurableHarness({
        database: await context.database(),
        sessionId: context.session.id,
        harness: harnessOptions,
      });
      try {
        const root = await harness.root(
          BACKGROUND_CONTEXT,
          options.agent === undefined ? undefined : { agent: options.agent },
        );
        await options.onOpen?.(harness, context);
        const graph = await harness.taskGraph(BACKGROUND_CONTEXT);
        const unsubscribe = harness.subscribeCommits(() => {
          notify();
          // Session APIs must not run inside synchronous commit listeners.
          queueMicrotask(kick);
        });
        const stop = () => {
          stopped = true;
          halted = true;
          notify();
          void harness.close(BACKGROUND_CONTEXT).finally(() => opened?.dispose()).catch(report);
        };
        signal.addEventListener("abort", stop, { once: true });
        opened = {
          harness,
          root,
          graph,
          dispose: () => {
            unsubscribe();
            graph.dispose();
            signal.removeEventListener("abort", stop);
          },
        };
        if (signal.aborted) {
          stop();
          throw signal.reason;
        }
        harness.resume();
        return opened;
      } catch (error) {
        await harness.close(BACKGROUND_CONTEXT);
        throw error;
      }
    })();
    try {
      return await opening;
    } catch (error) {
      opening = undefined;
      throw error;
    }
  }

  function kick(): void {
    const context = latest;
    if (halted || running || !opened || !context || !busy()) return;
    // An activity's completion can still be flushing its internal resume message.
    // That message rechecks the graph before the runtime can become quiescent.
    if (context.activity.active) return;
    running = true;
    let ready: () => void = () => {};
    observationReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    try {
      context.activity.start(
        async (activity) => {
          const owner = opened!;
          const renew = setInterval(
            () => {
              if (!activity.signal.aborted) {
                try {
                  context.activity.extend(timeout);
                } catch (error) {
                  report(error);
                  context.activity.cancel(error);
                }
              }
            },
            Math.max(1, Math.floor(timeout / 3)),
          );
          renew.unref();
          const stop = () => {
            halted = true;
            notify();
            void owner.harness.close(BACKGROUND_CONTEXT).catch(report);
          };
          activity.signal.addEventListener("abort", stop, { once: true });
          let watch: Awaited<ReturnType<Conversation["watch"]>> | undefined;
          let graphWatch:
            | Awaited<ReturnType<Harness["watchTaskGraph"]>>
            | undefined;
          let outputTail: Promise<void> = Promise.resolve();
          let observationError: unknown;
          let finalSnapshot: (() => Promise<void>) | undefined;
          let finalError: unknown;
          try {
            watch = await owner.root.watch(BACKGROUND_CONTEXT);
            const streamId = randomUUID();
            let sequence = 0;
            const publish = (
              update: Parameters<typeof encodePiDurableUpdate>[0],
            ): Promise<void> => {
              const events = encodePiDurableUpdate(
                update,
                streamId,
                sequence++,
              );
              outputTail = outputTail.then(async () => {
                for (const event of events) await activity.output.send(event);
              });
              // Attach a handler immediately, even when a source listener queues behind output.
              void outputTail.catch((error) => {
                observationError = error;
                notify();
              });
              return outputTail;
            };
            graphWatch = await owner.harness.watchTaskGraph(BACKGROUND_CONTEXT);
            finalSnapshot = async () => {
              const view = await owner.root.viewState(BACKGROUND_CONTEXT);
              try {
                await publish({
                  type: "snapshot",
                  conversationId: owner.root.id,
                  value: view.value,
                  tasks: owner.graph.value,
                });
              } finally {
                view.dispose();
              }
            };
            liveSnapshot = () =>
              publish({
                type: "snapshot",
                conversationId: owner.root.id,
                value: watch!.value,
                tasks: graphWatch!.value,
              });
            ready();
            await liveSnapshot();
            watch.start(async (_value, ops) => {
              await publish({
                type: "change",
                conversationId: owner.root.id,
                ops,
              });
            });
            graphWatch.start(async (value) => {
              await publish({
                type: "tasks",
                conversationId: owner.root.id,
                value,
              });
            });
            for (;;) {
              activity.signal.throwIfAborted();
              if (halted) throw new Error("Pi harness closed during execution");
              if (observationError !== undefined) throw observationError;
              if (!busy()) {
                const before = revision;
                await immediate();
                if (!busy() && before === revision) break;
                continue;
              }
              await new Promise<void>((resolve) => {
                const changed = () => {
                  listeners.delete(changed);
                  activity.signal.removeEventListener("abort", changed);
                  resolve();
                };
                listeners.add(changed);
                activity.signal.addEventListener("abort", changed, {
                  once: true,
                });
                if (activity.signal.aborted) changed();
              });
            }
          } catch (error) {
            if (!activity.signal.aborted) {
              report(error);
              halted = true;
              await owner.harness.close(BACKGROUND_CONTEXT);
              throw error;
            }
          } finally {
            clearInterval(renew);
            activity.signal.removeEventListener("abort", stop);
            if (watch) await watch.stop();
            if (graphWatch) await graphWatch.stop();
            // Stop may discard buffered watch frames. End with the current committed
            // snapshot so slow output never loses the final answer or terminal graph.
            liveSnapshot = finalSnapshot;
            if (!halted && finalSnapshot) {
              try {
                await finalSnapshot();
              } catch (error) {
                report(error);
                halted = true;
                finalError = error;
              }
            }
            await outputTail.catch(report);
            liveSnapshot = undefined;
            ready();
            observationReady = undefined;
            running = false;
            if (halted) {
              owner.dispose();
              closing = owner.harness.close(BACKGROUND_CONTEXT);
              await closing;
            }
            // InMemoryActivity tracks this flush through re-admission. It closes the
            // race between task graph idle and a concurrent new durable submission.
            else activity.send({ type: "resume" });
            if (finalError !== undefined) throw finalError;
          }
        },
        { timeoutMs: timeout },
      );
    } catch (error) {
      running = false;
      ready();
      observationReady = undefined;
      throw error;
    }
  }

  async function conversation(
    owner: Opened,
    id?: ConversationId,
  ): Promise<Conversation> {
    if (id === undefined || id === owner.root.id) return owner.root;
    if (!Number.isSafeInteger(id) || id < 1)
      throw new TypeError("Invalid Pi conversation ID");
    const found = await owner.harness.conversation(id, BACKGROUND_CONTEXT);
    if (!found) throw new Error("Unknown Pi conversation");
    return found;
  }

  return defineSessionBehaviour({
    redelivery: true,
    async onActivate(context) {
      lifetime ??= context.signal;
      await open(context);
      kick();
    },
    async onRecover(context) {
      await open(context);
      kick();
    },
    async receive(context: Intake) {
      inFlight++;
      notify();
      try {
        const owner = await open(context);
        const message = context.message.payload;
        switch (message.type) {
          case "input":
          case "write": {
            const target = await conversation(owner, message.conversationId);
            // Platform identity is authoritative, even if payload supplies requestId.
            const submission = await target.submit(
              { ...message, requestId: context.message.id },
              BACKGROUND_CONTEXT,
            );
            context.reply({
              type: "submitted",
              conversationId: target.id,
              submissionId: submission.id,
            });
            break;
          }
          case "abortSubmission":
            if (
              !Number.isSafeInteger(message.submissionId) ||
              message.submissionId < 1
            )
              throw new TypeError("Invalid Pi submission ID");
            if (
              (await owner.harness.abortSubmission(
                message.submissionId,
                BACKGROUND_CONTEXT,
              )) === "not_found"
            )
              throw new Error("Unknown Pi submission");
            context.reply({
              type: "abort-requested",
              target: "submission",
              id: message.submissionId,
            });
            break;
          case "abortTask":
            if (!Number.isSafeInteger(message.taskId) || message.taskId < 1)
              throw new TypeError("Invalid Pi task ID");
            if (
              !(await owner.harness.getTask(message.taskId, BACKGROUND_CONTEXT))
            )
              throw new Error("Unknown Pi task");
            await owner.harness.abortTask(message.taskId, BACKGROUND_CONTEXT);
            context.reply({
              type: "abort-requested",
              target: "task",
              id: message.taskId,
            });
            break;
          case "snapshot": {
            const target = await conversation(owner, message.conversationId);
            if (target.id === owner.root.id && running) await observationReady;
            if (halted) throw new Error("Pi Session observation has stopped");
            if (target.id === owner.root.id && liveSnapshot) {
              await liveSnapshot();
              context.reply({ type: "snapshot", conversationId: target.id });
              break;
            }
            const watch = await target.watch(BACKGROUND_CONTEXT);
            try {
              for (const event of encodePiDurableUpdate(
                {
                  type: "snapshot",
                  conversationId: target.id,
                  value: watch.value,
                  tasks: owner.graph.value,
                },
                randomUUID(),
                0,
              ))
                await context.output.send(event);
            } finally {
              await watch.stop();
            }
            context.reply({ type: "snapshot", conversationId: target.id });
            break;
          }
          case "resume":
            owner.harness.resume();
            context.reply({ type: "resumed" });
            break;
          default:
            throw new TypeError("Unsupported Pi Durable message");
        }
      } finally {
        inFlight--;
        notify();
        kick();
      }
    },
  });
}
