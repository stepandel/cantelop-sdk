import { assertSessionRuntime, RUNTIME_ID } from "./session-runtime-contract.js";
import type { SessionRuntime } from "./session-runtime-contract.js";
import { AppConfigurationError, type ConfigurationContext } from "./app-config.js";
import { edgeRequest, resolveEdgeConnection } from "./edge-connection.js";
import type { AppConnection, AppCommandEnvelope, AppOptions, IntegrationSessionOptions, SessionCancellation, SessionCommand, SessionCommandOptions, SessionSubmissionOptions, SessionStreamOptions, SessionView, WorkspaceRef, WorkspaceSelector, WorkspaceAuthLoginOptions, WorkspaceAuthLogin, WorkspaceAuthTerminal } from "./integration.js";
import type { MessageRef, SessionRequestOptions, Workspace } from "./resources.js";
import { AUTH_KEEP_ALIVE_SECONDS, AUTH_SESSION_ID, isAuthSessionID, AUTH_TERMINAL_PROTOCOL, LOGIN_ID_PATTERN, TERMINAL_ID_PATTERN, TERMINAL_TICKET_PATTERN, type AuthCommand, type AuthResult } from "./native-auth.js";
import { RemoteAppError, readWorkspace, readMessageStatus, requestJSON } from "./remote-app.js";
import { streamSessionEvents } from "./stream.js";
import { APP_COMMAND_PATH, MAX_COMMAND_BYTES, assertCursor, assertKeepAlive, assertMessageID, assertSessionID, messageID, record, SLUG_PATTERN, validateCommand, workspaceSelector } from "./integration-protocol.js";

/** A named App with a typed runtime and its own Workspace namespace. */
export class App<Message = unknown, Event = never, Reply = never, View = unknown> {
  readonly #name: string;
  get name(): string { return this.#name; }
  readonly #connection: AppConnection;

  readonly #sessionRuntime: SessionRuntime<Message, Event, Reply, View>;
  readonly #runtimeId: string | undefined;
  readonly #auth: boolean;

  get runtime(): SessionRuntime<Message, Event, Reply, View> { return this.#sessionRuntime; }

  constructor(options: AppOptions<Message, Event, Reply, View>, context: ConfigurationContext, profile?: string) {
    if (!options || typeof options.name !== "string" || !SLUG_PATTERN.test(options.name)) throw new TypeError("A valid App name is required");
    this.#name = options.name;
    assertSessionRuntime(options.runtime);
    this.#sessionRuntime = Object.freeze({ ...options.runtime });
    this.#runtimeId = (options.runtime as unknown as Record<symbol, string>)[RUNTIME_ID];
    this.#connection = resolveEdgeConnection(options, context, profile);
    this.#auth = options.auth !== undefined;
  }

  workspace(input: WorkspaceSelector): WorkspaceRef<Message, Event, Reply, View> {
    const connection = this.#connection;
    const runtimeId = this.#runtimeId;
    const edgeFetch = (request: Request) => {
      const headers = new Headers(request.headers);
      if (runtimeId !== undefined) headers.set("X-Cantelop-Session-Runtime", runtimeId);
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
    const authDeclared = this.#auth;
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
      auth() {
        if (!authDeclared) throw new TypeError("App does not declare auth");
        const requestAuth = async (auth: AuthCommand, options: SessionCommandOptions = {}): Promise<AuthResult> => {
          const id = options.id ?? messageID(); assertMessageID(id);
          const envelope = prepare({ protocolVersion: 2, id, workspace: selector,
            session: { id: AUTH_SESSION_ID }, command: { type: "auth", auth, timeoutMs: 120_000, keepAliveSeconds: AUTH_KEEP_ALIVE_SECONDS } });
          let value: unknown;
          try { value = await send(envelope, options.signal); }
          catch (error) { throw submissionError(error, id, options.signal); }
          if (!record(value) || value.protocolVersion !== 2 || value.id !== id || !record(value.reply) || typeof value.reply.type !== "string")
            throw new RemoteAppError("invalid_auth_response", 0, id);
          if (value.reply.type === "error") {
            const codes = ["auth_logout_unconfirmed","code_login_not_supported","login_failed","login_not_active","login_timeout","code_rejected"];
            if (typeof value.reply.code !== "string" || !codes.includes(value.reply.code)) throw new RemoteAppError("invalid_auth_response",0,id);
            throw new RemoteAppError(value.reply.code,400,id);
          }
          return value.reply as AuthResult;
        };
        const status = (value: AuthResult) => {
          if (value.type !== "status" || typeof value.authenticated !== "boolean") throw new RemoteAppError("invalid_auth_response", 0);
          return value.authenticated;
        };
        const terminal = async (options?: SessionCommandOptions): Promise<WorkspaceAuthTerminal> => {
            const value = await requestAuth({ type: "terminal" }, options) as AuthResult & { url?: unknown };
            if (value.type !== "terminal" || typeof value.terminalId !== "string" || !TERMINAL_ID_PATTERN.test(value.terminalId) ||
                typeof value.ticket !== "string" || !TERMINAL_TICKET_PATTERN.test(value.ticket) ||
                typeof value.url !== "string" || !/^wss?:\/\//.test(value.url) || !Number.isFinite(Date.parse(value.expiresAt))) throw new RemoteAppError("invalid_auth_response", 0);
            return Object.freeze({ terminalId: value.terminalId, url: value.url, protocols: Object.freeze([AUTH_TERMINAL_PROTOCOL, value.ticket] as const), expiresAt: new Date(value.expiresAt) });
        };
        return Object.freeze({
          async status(options?: SessionCommandOptions) { return status(await requestAuth({ type: "status" }, options)); },
          terminal,
          async login(options: WorkspaceAuthLoginOptions = {}): Promise<WorkspaceAuthLogin> {
            if (options.force !== undefined && typeof options.force !== "boolean") throw new TypeError("Invalid login force option");
            const value = await requestAuth({type:"login",...(options.force !== undefined ? {force:options.force} : {})}, options.signal ? {signal:options.signal} : {});
            if (value.type === "status") {
              if (!status(value)) throw new RemoteAppError("invalid_auth_response",0);
              return Object.freeze({authenticated:true});
            }
            if (value.type !== "login" || !LOGIN_ID_PATTERN.test(value.attemptId) || typeof value.url !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) throw new RemoteAppError("invalid_auth_response",0);
            const url = new URL(value.url);
            if (url.protocol !== "https:" || url.username || url.password) throw new RemoteAppError("invalid_auth_response",0);
            return Object.freeze({authenticated:false,attemptId:value.attemptId,url:url.href,expiresAt:new Date(value.expiresAt)});
          },
          async submitCode(options: {readonly attemptId:string;readonly code:string;readonly signal?:AbortSignal}) {
            return status(await requestAuth({type:"code",attemptId:options.attemptId,code:options.code}, options.signal ? {signal:options.signal} : {}));
          },
          async cancelLogin(options: {readonly attemptId:string;readonly signal?:AbortSignal}) {
            const value = await requestAuth({type:"cancel",attemptId:options.attemptId},options.signal ? {signal:options.signal} : {});
            if (value.type !== "cancelled" || value.attemptId !== options.attemptId) throw new RemoteAppError("invalid_auth_response",0);
          },
          async close(options: { readonly terminalId: string } & SessionCommandOptions) {
            if (typeof options?.terminalId !== "string" || !TERMINAL_ID_PATTERN.test(options.terminalId)) throw new TypeError("Invalid auth terminal ID");
            const value = await requestAuth({ type: "close", terminalId: options.terminalId }, options);
            if (value.type !== "closed" || value.terminalId !== options.terminalId) throw new RemoteAppError("invalid_auth_response", 0);
          },
          async logout(options?: SessionCommandOptions) { return status(await requestAuth({ type: "logout" }, options)); },
        });
      },
      session(config: IntegrationSessionOptions = {}) {
        const id = config.id ?? `ses_${crypto.randomUUID().replaceAll("-", "")}`;
        assertSessionID(id); assertKeepAlive(config.keepAliveSeconds);
        if (isAuthSessionID(id)) throw new TypeError("Reserved auth Session ID");
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
          async cancel(options: SessionCommandOptions = {}): Promise<SessionCancellation> {
            if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["id", "signal"].includes(key))) throw new TypeError("Invalid cancellation options");
            const commandId = options.id ?? messageID(); assertMessageID(commandId);
            let value: unknown;
            try { value = await send(envelope({ type: "cancel", ...keepAlive({}) }, commandId), options.signal); }
            catch (error) { throw submissionError(error, commandId, options.signal); }
            if (!record(value) || value.protocolVersion !== 2 || value.id !== commandId || !["requested", "idle"].includes(value.state as string)) throw new RemoteAppError("invalid_cancellation_response", 0, commandId);
            return Object.freeze({ state: value.state as SessionCancellation["state"] });
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
