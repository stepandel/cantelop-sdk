import { EDGE_ORIGIN, isRecord, messageID, sessionID, WORKSPACE_ID_PATTERN } from "./shared.js";
import type { SessionRuntime } from "./session-runtime-contract.js";
import { createAppEnvironment, type AppEnvironment } from "./environment.js";
import { AppConfigurationError, type NormalizedAppOptions } from "./app-config.js";
import { edgeRequest } from "./edge-connection.js";
import type { AppConnection, AppCommandEnvelope, AppEnvironmentEnvelope, IntegrationSessionOptions, SessionCancellation, SessionCommand, SessionCommandOptions, SessionSubmissionOptions, SessionStreamOptions, SessionView, WorkspaceRef, WorkspaceSelector, WorkspaceAuthLoginOptions, WorkspaceAuthLogin, WorkspaceAuthTerminal, WorkspaceOperationOptions, WorkspaceDeletion } from "./integration.js";
import type { MessageRef, SessionRequestOptions, Workspace } from "./resources.js";
import { AUTH_KEEP_ALIVE_SECONDS, AUTH_SESSION_ID, isReservedAuthSessionID, AUTH_TERMINAL_PROTOCOL, LOGIN_ID_PATTERN, TERMINAL_ID_PATTERN, TERMINAL_TICKET_PATTERN, type AuthCommand, type AuthResult } from "./native-auth.js";
import { RemoteAppError, readWorkspace, readMessageStatus, requestJSON } from "./transport.js";
import { streamSessionEvents } from "./stream.js";
import type { WorkspaceSyncOptions } from "./sync.js";
import { CANTELOP_INTEGRATION_PROTOCOL_VERSION as PROTOCOL_VERSION, DEFAULT_REQUEST_TIMEOUT_MS, appCommandPath, assertCursor, assertKeepAlive, assertSessionID, encodeCommand, workspaceSelector, type ProtocolEnvelope, type WorkspaceCommandType } from "./integration-protocol.js";

/** Native logins wait for a human; give them longer than an ordinary request. */
const AUTH_REQUEST_TIMEOUT_MS = 120_000;
/** Auth failures the Sandbox reports as stable, caller-visible codes. */
const AUTH_ERROR_CODES: ReadonlySet<unknown> = new Set(["auth_logout_unconfirmed", "code_login_not_supported", "login_failed", "login_not_active", "login_timeout", "code_rejected"]);
const SESSION_RUNTIME_HEADER = "X-Cantelop-Session-Runtime";
const CANCEL_OPTION_KEYS: ReadonlySet<string> = new Set(["id", "signal"]);

type Reply = Record<string, unknown>;

/** One App's command transport: every command is encoded and validated exactly once, then sent once. */
interface CommandChannel {
  /** Commands whose failures propagate unchanged (Workspace operations, status, view, stop). */
  send(envelope: ProtocolEnvelope, signal?: AbortSignal): Promise<unknown>;
  /**
   * Submissions: a validation failure is thrown before transport, an ambiguous failure carries
   * the command ID for a safe retry, and the reply must echo that ID.
   */
  exchange(envelope: ProtocolEnvelope, signal: AbortSignal | undefined, invalidCode: string, valid?: (reply: Reply) => boolean): Promise<Reply>;
  /** Opens the command's event stream. */
  stream(envelope: AppCommandEnvelope, signal: AbortSignal): Promise<Response>;
  /** Raw Edge requests (Workspace sync) addressed and identified like commands. */
  fetch(request: Request): Promise<Response>;
}

function commandChannel(connection: AppConnection, headers: Readonly<Record<string, string>>): CommandChannel {
  const fetch = (request: Request) => connection.fetch(request);
  const post = (envelope: ProtocolEnvelope, json: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return requestJSON(fetch, `${EDGE_ORIGIN}${appCommandPath(envelope.command.type)}`, { method: "POST", json, headers, ...(signal === undefined ? {} : { signal }) });
  };
  return {
    send: async (envelope, signal) => post(envelope, encodeCommand(envelope), signal),
    async exchange(envelope, signal, invalidCode, valid) {
      const json = encodeCommand(envelope);
      let value: unknown;
      try { value = await post(envelope, json, signal); }
      catch (error) { throw submissionError(error, envelope.id, signal); }
      if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.id !== envelope.id || (valid !== undefined && !valid(value))) {
        throw new RemoteAppError(invalidCode, 0, envelope.id);
      }
      return value;
    },
    stream: (envelope, signal) => fetch(new Request(`${EDGE_ORIGIN}${appCommandPath("stream")}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "text/event-stream" }, body: encodeCommand(envelope), signal,
    })),
    fetch: request => fetch(edgeRequest(request, headers)),
  };
}

/** A named App with a typed runtime and its own Workspace namespace. */
export class App<Message = unknown, Event = never, Reply = never, View = unknown> {
  readonly #options: NormalizedAppOptions<Message, Event, Reply, View>;
  readonly #connection: AppConnection;
  readonly #commands: CommandChannel;

  get name(): string { return this.#options.name; }
  get runtime(): SessionRuntime<Message, Event, Reply, View> { return this.#options.runtime; }

  /** Created by `CantelopClient.app()` (or the Edge Worker) from options validated once by normalizeAppOptions. */
  constructor(options: NormalizedAppOptions<Message, Event, Reply, View>, connection: AppConnection) {
    this.#options = options;
    this.#connection = connection;
    this.#commands = commandChannel(connection, options.runtimeId === undefined ? {} : { [SESSION_RUNTIME_HEADER]: options.runtimeId });
  }

  environment(): AppEnvironment {
    // App-scoped commands do not depend on Sandbox runtime compatibility, so they carry no runtime identity.
    const commands = commandChannel(this.#connection, {});
    return createAppEnvironment(async (command, options = {}) => {
      options.signal?.throwIfAborted();
      const envelope: AppEnvironmentEnvelope = { protocolVersion: PROTOCOL_VERSION, id: options.id ?? messageID(), workspace: null, session: null, command };
      return commands.exchange(envelope, options.signal, "invalid_environment_response");
    });
  }

  workspace(input: WorkspaceSelector): WorkspaceRef<Message, Event, Reply, View> {
    const commands = this.#commands;
    const localDatabaseOrigin = this.#connection.localDatabaseOrigin;
    const authDeclared = this.#options.auth;
    const selector = workspaceSelector(input);
    let pending: Promise<Workspace> | undefined;
    const workspaceCommand = (type: WorkspaceCommandType, workspace: WorkspaceSelector = selector, signal?: AbortSignal) =>
      commands.send({ protocolVersion: PROTOCOL_VERSION, id: messageID(), workspace, session: null, command: { type } }, signal);
    const loadCredentials = (id: string) => workspaceCommand("workspace.database", { id });
    function readBoundWorkspace(value: unknown): Workspace {
      const workspace = readWorkspace(value, loadCredentials, localDatabaseOrigin);
      if (selector.id !== undefined ? workspace.id !== selector.id : workspace.slug !== selector.slug) throw new TypeError("The connection returned a different Workspace");
      return workspace;
    }
    function resolve(): Promise<Workspace> {
      pending ??= workspaceCommand("workspace.resolve").then(readBoundWorkspace).catch(error => { pending = undefined; throw error; });
      return pending;
    }
    async function inspect(options: WorkspaceOperationOptions = {}): Promise<Workspace | undefined> {
      const value = await workspaceCommand("workspace.inspect", selector, options.signal);
      if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || !("workspace" in value)) throw new RemoteAppError("invalid_workspace_inspection_response", 0);
      return value.workspace === null ? undefined : readBoundWorkspace(value.workspace);
    }
    return Object.freeze({
      selector, resolve, inspect,
      async delete(options: WorkspaceOperationOptions = {}): Promise<WorkspaceDeletion | undefined> {
        const id = selector.id ?? (await inspect(options))?.id;
        if (id === undefined) return undefined;
        // A lost response can still mean deletion was accepted. Clear once the
        // call settles so a resolve() made while it was in flight is not kept.
        const value = await workspaceCommand("workspace.delete", { id }, options.signal).finally(() => { pending = undefined; });
        if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.id !== id || value.status !== "deleting" || typeof value.hostArchived !== "boolean") throw new RemoteAppError("invalid_workspace_deletion_response", 0);
        return Object.freeze({ id, status: "deleting", hostArchived: value.hostArchived });
      },
      async database() { return (await resolve()).database(); },
      async sync(options: WorkspaceSyncOptions) {
        const workspace = await resolve();
        const { startSync } = await import("#cantelop-sync");
        return startSync(options, workspace.id, commands.fetch);
      },
      auth() {
        if (!authDeclared) throw new TypeError("App does not declare auth");
        return workspaceAuth(commands, selector);
      },
      session: (config: IntegrationSessionOptions = {}) => workspaceSession<Message, Event, Reply, View>(commands, selector, config),
    });
  }
}

function workspaceAuth(commands: CommandChannel, selector: WorkspaceSelector) {
  const requestAuth = async (auth: AuthCommand, options: SessionCommandOptions = {}): Promise<AuthResult> => {
    const envelope: AppCommandEnvelope = { protocolVersion: PROTOCOL_VERSION, id: options.id ?? messageID(), workspace: selector,
      session: { id: AUTH_SESSION_ID }, command: { type: "auth", auth, timeoutMs: AUTH_REQUEST_TIMEOUT_MS, keepAliveSeconds: AUTH_KEEP_ALIVE_SECONDS } };
    const value = await commands.exchange(envelope, options.signal, "invalid_auth_response", value => isRecord(value.reply) && typeof value.reply.type === "string");
    const reply = value.reply as Reply;
    if (reply.type === "error") {
      if (!AUTH_ERROR_CODES.has(reply.code)) throw new RemoteAppError("invalid_auth_response", 0, envelope.id);
      throw new RemoteAppError(reply.code as string, 400, envelope.id);
    }
    return reply as unknown as AuthResult;
  };
  const signalOnly = (signal: AbortSignal | undefined) => signal ? { signal } : {};
  const status = (value: AuthResult) => {
    if (value.type !== "status" || typeof value.authenticated !== "boolean") throw new RemoteAppError("invalid_auth_response", 0);
    return value.authenticated;
  };
  return Object.freeze({
    async status(options?: SessionCommandOptions) { return status(await requestAuth({ type: "status" }, options)); },
    async terminal(options?: SessionCommandOptions): Promise<WorkspaceAuthTerminal> {
      const value = await requestAuth({ type: "terminal" }, options) as AuthResult & { url?: unknown };
      if (value.type !== "terminal" || typeof value.terminalId !== "string" || !TERMINAL_ID_PATTERN.test(value.terminalId) ||
          typeof value.ticket !== "string" || !TERMINAL_TICKET_PATTERN.test(value.ticket) ||
          typeof value.url !== "string" || !/^wss?:\/\//.test(value.url) || !Number.isFinite(Date.parse(value.expiresAt))) throw new RemoteAppError("invalid_auth_response", 0);
      return Object.freeze({ terminalId: value.terminalId, url: value.url, protocols: Object.freeze([AUTH_TERMINAL_PROTOCOL, value.ticket] as const), expiresAt: new Date(value.expiresAt) });
    },
    async login(options: WorkspaceAuthLoginOptions = {}): Promise<WorkspaceAuthLogin> {
      if (options.force !== undefined && typeof options.force !== "boolean") throw new TypeError("Invalid login force option");
      const value = await requestAuth({ type: "login", ...(options.force !== undefined ? { force: options.force } : {}) }, signalOnly(options.signal));
      if (value.type === "status") {
        if (!status(value)) throw new RemoteAppError("invalid_auth_response", 0);
        return Object.freeze({ authenticated: true });
      }
      if (value.type !== "login" || !LOGIN_ID_PATTERN.test(value.attemptId) || typeof value.url !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) throw new RemoteAppError("invalid_auth_response", 0);
      const url = new URL(value.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new RemoteAppError("invalid_auth_response", 0);
      return Object.freeze({ authenticated: false, attemptId: value.attemptId, url: url.href, expiresAt: new Date(value.expiresAt) });
    },
    async submitCode(options: { readonly attemptId: string; readonly code: string; readonly signal?: AbortSignal }) {
      return status(await requestAuth({ type: "code", attemptId: options.attemptId, code: options.code }, signalOnly(options.signal)));
    },
    async cancelLogin(options: { readonly attemptId: string; readonly signal?: AbortSignal }) {
      const value = await requestAuth({ type: "cancel", attemptId: options.attemptId }, signalOnly(options.signal));
      if (value.type !== "cancelled" || value.attemptId !== options.attemptId) throw new RemoteAppError("invalid_auth_response", 0);
    },
    async close(options: { readonly terminalId: string } & SessionCommandOptions) {
      if (typeof options?.terminalId !== "string" || !TERMINAL_ID_PATTERN.test(options.terminalId)) throw new TypeError("Invalid auth terminal ID");
      const value = await requestAuth({ type: "close", terminalId: options.terminalId }, options);
      if (value.type !== "closed" || value.terminalId !== options.terminalId) throw new RemoteAppError("invalid_auth_response", 0);
    },
    async logout(options?: SessionCommandOptions) { return status(await requestAuth({ type: "logout" }, options)); },
  });
}

function workspaceSession<Message, Event, Reply, View>(commands: CommandChannel, selector: WorkspaceSelector, config: IntegrationSessionOptions) {
  const id = config.id ?? sessionID();
  assertSessionID(id); assertKeepAlive(config.keepAliveSeconds);
  if (isReservedAuthSessionID(id)) throw new TypeError("Reserved auth Session ID");
  const keepAliveSeconds = config.keepAliveSeconds;
  const envelope = (command: SessionCommand, commandId = messageID()): AppCommandEnvelope =>
    ({ protocolVersion: PROTOCOL_VERSION, id: commandId, workspace: selector, session: { id }, command });
  /** A per-call override (validated here: `null` must not fall back) or the reference default. */
  const keepAlive = (override?: number) => {
    assertKeepAlive(override);
    const value = override ?? keepAliveSeconds;
    return value === undefined ? {} : { keepAliveSeconds: value };
  };
  async function submit(type: "dispatch" | "steer", message: Message, options: SessionSubmissionOptions = {}): Promise<MessageRef> {
    const submissionId = options.id ?? messageID();
    const value = await commands.exchange(envelope({ type, message, ...keepAlive(options.keepAliveSeconds) }, submissionId), options.signal, "invalid_message_response",
      value => value.status === "accepted" && typeof value.accepted_at === "string" && Number.isFinite(Date.parse(value.accepted_at)));
    return Object.freeze({ id: submissionId, state: "accepted", acceptedAt: new Date(value.accepted_at as string),
      async status() {
        const value = await commands.send(envelope({ type: "status", messageId: submissionId }));
        if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) throw new RemoteAppError("invalid_message_status_response", 0);
        return readMessageStatus(value, submissionId);
      },
    });
  }
  return Object.freeze({
    id, workspace: selector, ...(keepAliveSeconds === undefined ? {} : { keepAliveSeconds }),
    dispatch: (message: Message, options?: SessionSubmissionOptions) => submit("dispatch", message, options),
    steer: (message: Message, options?: SessionSubmissionOptions) => submit("steer", message, options),
    async request(message: Message, options: SessionRequestOptions = {}): Promise<Reply> {
      const command = envelope({ type: "request", message, timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, ...keepAlive() }, options.id ?? messageID());
      const value = await commands.exchange(command, options.signal, "invalid_request_response", value => "reply" in value);
      return value.reply as Reply;
    },
    stream: (options?: SessionStreamOptions) => streamSessionEvents<Event>(request => {
      const url = new URL(request.url);
      const after = url.searchParams.has("after") ? { streamId: url.searchParams.get("stream_id")!, sequence: Number(url.searchParams.get("after")) } : undefined;
      return commands.stream(envelope({ type: "stream", ...(after === undefined ? {} : { after }) }), request.signal);
    }, id, options),
    async cancel(options: SessionCommandOptions = {}): Promise<SessionCancellation> {
      if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !CANCEL_OPTION_KEYS.has(key))) throw new TypeError("Invalid cancellation options");
      const value = await commands.exchange(envelope({ type: "cancel", ...keepAlive() }, options.id ?? messageID()), options.signal, "invalid_cancellation_response",
        value => value.state === "requested" || value.state === "idle");
      return Object.freeze({ state: value.state as SessionCancellation["state"] });
    },
    async view(options: { readonly signal?: AbortSignal } = {}): Promise<SessionView<View>> {
      const value = await commands.send(envelope({ type: "view" }), options.signal);
      if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.sessionId !== id || typeof value.revision !== "string" || !value.revision || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || !("state" in value)) throw new RemoteAppError("invalid_session_view", 0);
      if (typeof value.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspaceId)) throw new RemoteAppError("invalid_session_view", 0);
      if (selector.id !== undefined && value.workspaceId !== selector.id) throw new RemoteAppError("workspace_conflict", 0);
      try { assertCursor(value.cursor); } catch { throw new RemoteAppError("invalid_session_view", 0); }
      return Object.freeze({ revision: value.revision, updatedAt: new Date(value.updatedAt), state: value.state as View, cursor: Object.freeze({ ...value.cursor as { streamId: string; sequence: number } }) });
    },
    async stop() { await commands.send(envelope({ type: "stop" })); },
  });
}

function submissionError(error: unknown, id: string, signal?: AbortSignal): unknown {
  if (signal?.aborted || error instanceof AppConfigurationError) return error;
  if (error instanceof RemoteAppError) return new RemoteAppError(error.code, error.status, id, { cause: error });
  return new RemoteAppError("command_outcome_unknown", 0, id, { cause: error });
}
