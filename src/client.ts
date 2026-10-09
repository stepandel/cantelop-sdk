import { assertSessionRuntime } from "./session-runtime-definition.js";
import type { AnySessionRuntime, RuntimeMessage, RuntimeEvent, RuntimeReply, RuntimeView } from "./session-runtime-definition.js";
import { AppConfigurationError } from "./app-config.js";
import { edgeRequest, resolveEdgeConnection } from "./edge-connection.js";
import type { AppConnection, AppCommandEnvelope, CantelopClientOptions, IntegrationSessionOptions, MessageCancellation, SessionCommand, SessionCommandOptions, SessionSubmissionOptions, SessionStreamOptions, SessionView, WorkspaceRef, WorkspaceSelector } from "./integration.js";
import type { MessageRef, SessionRequestOptions, Workspace } from "./resources.js";
import { RemoteAppError, readWorkspace, readMessageStatus, requestJSON } from "./remote-app.js";
import { streamSessionEvents } from "./stream.js";
import { APP_COMMAND_PATH, MAX_COMMAND_BYTES, assertCursor, assertKeepAlive, assertMessageID, assertSessionID, messageID, record, validateCommand, workspaceSelector } from "./integration-protocol.js";

/** A backend client bound to one App's protocol-managed Edge API. */
export class CantelopClient<Runtime extends AnySessionRuntime = AnySessionRuntime> {
  readonly #connection: AppConnection;

  readonly #sessionRuntime: Runtime;

  get sessionRuntime(): Runtime { return this.#sessionRuntime; }

  constructor(options: CantelopClientOptions<Runtime>) {
    assertSessionRuntime(options?.sessionRuntime);
    this.#sessionRuntime = Object.freeze({ id: options.sessionRuntime.id, entrypoint: options.sessionRuntime.entrypoint }) as Runtime;
    this.#connection = resolveEdgeConnection(options);
  }

  workspace(input: WorkspaceSelector): WorkspaceRef<RuntimeMessage<Runtime>, RuntimeEvent<Runtime>, RuntimeReply<Runtime>, RuntimeView<Runtime>> {
    type Message = RuntimeMessage<Runtime>;
    type Event = RuntimeEvent<Runtime>;
    type Reply = RuntimeReply<Runtime>;
    type View = RuntimeView<Runtime>;
    const connection = this.#connection;
    const runtimeId = this.#sessionRuntime.id;
    const edgeFetch = (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("X-Cantelop-Session-Runtime", runtimeId);
      return connection.fetch(edgeRequest(new Request(request, { headers })));
    };
    function send(envelope: AppCommandEnvelope, signal?: AbortSignal) {
      signal?.throwIfAborted();
      validateCommand(envelope);
      return requestJSON(edgeFetch, APP_COMMAND_PATH, { method: "POST", body: envelope, ...(signal === undefined ? {} : { signal }) });
    }
    function prepare(envelope: AppCommandEnvelope): AppCommandEnvelope {
      const serialized = JSON.stringify(envelope);
      if (new TextEncoder().encode(serialized).byteLength > MAX_COMMAND_BYTES) throw new TypeError("Command exceeds 1 MiB");
      return validateCommand(JSON.parse(serialized));
    }
    const selector = workspaceSelector(input);
    let pending: Promise<Workspace> | undefined;
    const workspaceCommand = (type: "workspace.resolve" | "workspace.database", workspace = selector) => send({ protocolVersion: 2, id: messageID(), workspace, session: null, command: { type } });
    function resolve(): Promise<Workspace> {
      pending ??= workspaceCommand("workspace.resolve").then(value => {
        const databaseFetch = async (request: Request) => {
          const body = await request.json() as { workspace_id: string };
          return Response.json(await workspaceCommand("workspace.database", { id: body.workspace_id }));
        };
        const workspace = readWorkspace(value, databaseFetch, connection.localDatabaseOrigin);
        if (selector.id !== undefined ? workspace.id !== selector.id : workspace.slug !== selector.slug) throw new TypeError("The connection returned a different Workspace");
        return workspace;
      }).catch(error => { pending = undefined; throw error; });
      return pending;
    }
    return Object.freeze({
      selector, resolve,
      async database() { return (await resolve()).database(); },
      session(config: IntegrationSessionOptions = {}) {
        const id = config.id ?? `ses_${crypto.randomUUID().replaceAll("-", "")}`;
        assertSessionID(id); assertKeepAlive(config.keepAliveSeconds);
        const keepAliveSeconds = config.keepAliveSeconds;
        const envelope = (command: SessionCommand, commandId = messageID()): AppCommandEnvelope => ({ protocolVersion: 2, id: commandId, workspace: selector, session: { id }, command });
        const keepAlive = (options: { readonly keepAliveSeconds?: number }) => {
          assertKeepAlive(options.keepAliveSeconds);
          const value = options.keepAliveSeconds ?? keepAliveSeconds;
          assertKeepAlive(value);
          return value === undefined ? {} : { keepAliveSeconds: value };
        };
        async function submit(type: "dispatch" | "steer", message: Message, options: SessionSubmissionOptions = {}): Promise<MessageRef> {
          const submissionId = options.id ?? messageID(); assertMessageID(submissionId);
          const command = prepare(envelope({ type, message, ...keepAlive(options) }, submissionId));
          let value: unknown;
          try { value = await send(command, options.signal); }
          catch (error) { throw submissionError(error, submissionId, options.signal); }
          if (!record(value) || value.protocolVersion !== 2 || value.id !== submissionId || value.status !== "accepted" || typeof value.accepted_at !== "string" || !Number.isFinite(Date.parse(value.accepted_at))) throw new RemoteAppError("invalid_message_response", 0, submissionId);
          return Object.freeze({ id: submissionId, state: "accepted", acceptedAt: new Date(value.accepted_at),
            async status() {
              const value = await send(envelope({ type: "status", messageId: submissionId }));
              if (!record(value) || value.protocolVersion !== 2) throw new RemoteAppError("invalid_message_status_response", 0);
              return readMessageStatus(value, submissionId);
            },
          });
        }
        return Object.freeze({
          id, workspace: selector, ...(keepAliveSeconds === undefined ? {} : { keepAliveSeconds }),
          dispatch: (message: Message, options?: SessionSubmissionOptions) => submit("dispatch", message, options),
          steer: (message: Message, options?: SessionSubmissionOptions) => submit("steer", message, options),
          async request(message: Message, options: SessionRequestOptions = {}): Promise<Reply> {
            const submissionId = options.id ?? messageID(); assertMessageID(submissionId);
            const command = prepare(envelope({ type: "request", message, timeoutMs: options.timeoutMs ?? 30000, ...keepAlive({}) }, submissionId));
            let value: unknown;
            try { value = await send(command, options.signal); }
            catch (error) { throw submissionError(error, submissionId, options.signal); }
            if (!record(value) || value.protocolVersion !== 2 || value.id !== submissionId || !("reply" in value)) throw new RemoteAppError("invalid_request_response", 0, submissionId);
            return value.reply as Reply;
          },
          stream: (options?: SessionStreamOptions) => streamSessionEvents<Event>(request => {
            const url = new URL(request.url);
            const after = url.searchParams.has("after") ? { streamId: url.searchParams.get("stream_id")!, sequence: Number(url.searchParams.get("after")) } : undefined;
            const command = envelope({ type: "stream", ...(after === undefined ? {} : { after }) });
            return edgeFetch(new Request(`https://edge.cantelop.internal${APP_COMMAND_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(command), signal: request.signal }));
          }, id, options),
          async cancel(messageId: string, options: SessionCommandOptions = {}): Promise<MessageCancellation> {
            assertMessageID(messageId);
            const commandId = options.id ?? messageID(); assertMessageID(commandId);
            let value: unknown;
            try { value = await send(envelope({ type: "cancel", messageId }, commandId), options.signal); }
            catch (error) { throw submissionError(error, commandId, options.signal); }
            if (!record(value) || value.protocolVersion !== 2 || value.id !== commandId || value.messageId !== messageId || typeof value.state !== "string" || !["requested", "cancelled", "settled"].includes(value.state)) throw new RemoteAppError("invalid_cancellation_response", 0, commandId);
            const status = value.status === undefined ? undefined : readMessageStatus(value.status, messageId);
            if (value.state === "settled" && (!status || !["handled", "failed"].includes(status.state))) throw new RemoteAppError("invalid_cancellation_response", 0, commandId);
            return Object.freeze({ messageId, state: value.state as MessageCancellation["state"], ...(status === undefined ? {} : { status }) });
          },
          async view(options: { readonly signal?: AbortSignal } = {}): Promise<SessionView<View>> {
            const value = await send(envelope({ type: "view" }), options.signal);
            if (!record(value) || value.protocolVersion !== 2 || value.sessionId !== id || typeof value.revision !== "string" || !value.revision || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || !("state" in value)) throw new RemoteAppError("invalid_session_view", 0);
            if (typeof value.workspaceId !== "string" || !/^wsp_[0-9a-f]{32}$/.test(value.workspaceId)) throw new RemoteAppError("invalid_session_view", 0);
            if (selector.id !== undefined && value.workspaceId !== selector.id) throw new RemoteAppError("workspace_conflict", 0);
            try { assertCursor(value.cursor); } catch { throw new RemoteAppError("invalid_session_view", 0); }
            return Object.freeze({ revision: value.revision, updatedAt: new Date(value.updatedAt), state: value.state as View, cursor: Object.freeze({ ...value.cursor as { streamId: string; sequence: number } }) });
          },
          async stop() { await send(envelope({ type: "stop" })); },
        });
      },
    });
  }
}
function submissionError(error: unknown, id: string, signal?: AbortSignal): unknown {
  if (signal?.aborted || error instanceof AppConfigurationError) return error;
  if (error instanceof RemoteAppError) return new RemoteAppError(error.code, error.status, id, { cause: error });
  return new RemoteAppError("command_outcome_unknown", 0, id, { cause: error });
}
