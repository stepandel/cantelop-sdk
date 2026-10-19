import type { EnvironmentCommand } from "./environment.js";
import type { HomepageHandler, WebhookRoutes } from "./webhooks.js";
import type { AppDeploymentConfiguration } from "./app-definition.js";
import type { SessionRuntime } from "./session-runtime-contract.js";
import type { WorkspaceDatabase } from "./database.js";
import type { AppAuth, AuthCommand } from "./native-auth.js";
import type { MessageRef, SessionRequestOptions, Workspace } from "./resources.js";
import type { WorkspaceSync, WorkspaceSyncOptions } from "./sync.js";
import type { WorkspaceCommandType } from "./integration-protocol.js";

/** Exactly one canonical ID or App-scoped slug. */
export type WorkspaceSelector =
  | { readonly id: string; readonly slug?: never }
  | { readonly slug: string; readonly id?: never };

export interface IntegrationSessionOptions {
  readonly id?: string;
  readonly keepAliveSeconds?: number;
}

/** A trusted, App-bound connection supplied by the platform or local CLI. */
export interface AppConnection {
  /** Requests address the App Edge protocol at a logical Edge origin; the connection owns routing and authentication. */
  fetch(request: Request): Promise<Response>;
  /** Reserved for local CLI database connections. */
  readonly localDatabaseOrigin?: string;
}

/** Select an App by identity; its connection is resolved from runtime/CLI configuration. */
export type AppSelector =
  | { readonly id: string; readonly slug?: never }
  | { readonly slug: string; readonly id?: never };

/** Shared connection context; independent of any App or runtime. */
export interface CantelopClientOptions {
  readonly profile?: string;
}

/** A named App owns its runtime and Workspace namespace. */
export type AppOptions<Message = unknown, Event = never, Reply = never, View = unknown> = {
  readonly name: string;
  readonly runtime: SessionRuntime<Message, Event, Reply, View>;
  readonly webhooks?: WebhookRoutes<Message, Event, Reply, View>;
  /** Optional GET/HEAD handler for the App root. */
  readonly homepage?: HomepageHandler<Message, Event, Reply, View>;
  /** Native CLI sign-in for each Workspace; runs only in the Workspace auth Sandbox. */
  readonly auth?: AppAuth;
} & AppDeploymentConfiguration & (
  | { readonly connection?: never; readonly edgeUrl?: never; readonly accessToken?: never }
  | { readonly connection: AppConnection; readonly edgeUrl?: never; readonly accessToken?: never }
  | { readonly edgeUrl: string; readonly accessToken: string; readonly connection?: never }
);

export interface WorkspaceRef<Message, Event = unknown, Reply = unknown, View = unknown> {
  readonly selector: WorkspaceSelector;
  /** Resolves/provisions a slug, or retrieves an existing canonical ID. */
  resolve(): Promise<Workspace>;
  /** Read an existing Workspace without provisioning or caching a slug. */
  inspect(options?: WorkspaceOperationOptions): Promise<Workspace | undefined>;
  /** Permanently delete remote data. Slugs are inspected first; IDs permit retrying an archived Workspace's purge. */
  delete(options?: WorkspaceOperationOptions): Promise<WorkspaceDeletion | undefined>;
  database(): Promise<WorkspaceDatabase>;
  /** Node.js: continuously reconcile a local directory with this Workspace's project/ directory. */
  sync(options: WorkspaceSyncOptions): Promise<WorkspaceSync>;
  /** Native CLI authentication shared by Sessions in this Workspace. Requires `auth` on the App. */
  auth(): WorkspaceAuthRef;
  /** A lazy reference; omitting id generates a fresh App-scoped identity. */
  session(options?: IntegrationSessionOptions): SessionRef<Message, Event, Reply, View>;
}

export interface WorkspaceOperationOptions { readonly signal?: AbortSignal; }
export interface WorkspaceDeletion {
  readonly id: string;
  readonly status: "deleting";
  /** Host admission is closed; filesystem and database purge may still be pending. */
  readonly hostArchived: boolean;
}

/** Structured login methods allocate SDK command identities and keep native credentials private. */
export interface WorkspaceAuthLoginOptions {
  readonly signal?: AbortSignal;
  /** Confirm native logout before starting a fresh login, even if currently authenticated. */
  readonly force?: boolean;
}
export type WorkspaceAuthLogin =
  | { readonly authenticated: true }
  | { readonly authenticated: false; readonly attemptId: string; readonly url: string; readonly expiresAt: Date };

export interface WorkspaceAuthRef {
  /** Reuse a signed-in Workspace or open native login; force requires confirmed logout. */
  login(options?: WorkspaceAuthLoginOptions): Promise<WorkspaceAuthLogin>;
  /** Submit only the provider code; raw CLI input/output is not exposed. */
  submitCode(options: { readonly attemptId: string; readonly code: string; readonly signal?: AbortSignal }): Promise<boolean>;
  cancelLogin(options: { readonly attemptId: string; readonly signal?: AbortSignal }): Promise<void>;
  status(options?: SessionCommandOptions): Promise<boolean>;
  /**
   * Starts the native CLI login and returns a single-use terminal for the user's browser:
   * `new WebSocket(terminal.url, terminal.protocols)`. Binary frames carry raw terminal
   * bytes in both directions; the code the user pastes never reaches the App.
   */
  terminal(options?: SessionCommandOptions): Promise<WorkspaceAuthTerminal>;
  /** Ends an unfinished login. */
  close(options: { readonly terminalId: string } & SessionCommandOptions): Promise<void>;
  logout(options?: SessionCommandOptions): Promise<boolean>;
}

export interface WorkspaceAuthTerminal {
  readonly terminalId: string;
  /** Public `wss:` URL on the App Edge. */
  readonly url: string;
  /** Pass unchanged as the WebSocket subprotocols; the second entry is the single-use ticket. */
  readonly protocols: readonly [string, string];
  /** The browser must connect before this time. */
  readonly expiresAt: Date;
}

export interface SessionRef<Message, Event = unknown, Reply = unknown, View = unknown> {
  readonly id: string;
  readonly workspace: WorkspaceSelector;
  readonly keepAliveSeconds?: number;
  dispatch(message: Message, options?: SessionSubmissionOptions): Promise<MessageRef>;
  request(message: Message, options?: SessionRequestOptions): Promise<Reply>;
  /** Explicit resume only; ending this subscription never cancels agent work. */
  stream(options?: SessionStreamOptions): AsyncIterable<SessionEvent<Event>>;
  /** Delegates redirection to the harness implementation’s steer method. */
  steer(message: Message, options?: SessionSubmissionOptions): Promise<MessageRef>;
  /** Cooperative cancellation; acceptance is not cancellation completion. */
  cancel(options?: SessionCommandOptions): Promise<SessionCancellation>;
  /** Last committed application projection; never provisions or activates. */
  view(options?: { readonly signal?: AbortSignal }): Promise<SessionView<View>>;
  /** Releases the Sandbox. This identity remains reusable. */
  stop(): Promise<void>;
}

export interface SessionCommandOptions {
  /** Reuse this identity to retry an ambiguous command safely. */
  readonly id?: string;
  readonly signal?: AbortSignal;
}

export interface SessionSubmissionOptions extends SessionCommandOptions {
  /** Overrides the reference default; omission delegates to the configured App default. */
  readonly keepAliveSeconds?: number;
}

export interface SessionCancellation {
  /** requested means the active run was signalled; idle means there was no active run. */
  readonly state: "requested" | "idle";
}

export interface SessionView<View = unknown> {
  readonly revision: string;
  readonly updatedAt: Date;
  readonly state: View;
  /** Atomic event boundary for subscribing after this snapshot. */
  readonly cursor: SessionEventCursor;
}

/** Public App ↔ Edge command protocol. Edge ↔ Sandbox remains the actor protocol. */
export type SessionCommand<Message = unknown> =
  | { readonly type: "auth"; readonly auth: AuthCommand; readonly timeoutMs: number; readonly keepAliveSeconds?: number }
  | { readonly type: "dispatch" | "steer"; readonly message: Message; readonly keepAliveSeconds?: number }
  | { readonly type: "request"; readonly message: Message; readonly keepAliveSeconds?: number; readonly timeoutMs: number }
  | { readonly type: "cancel"; readonly keepAliveSeconds?: number }
  | { readonly type: "status"; readonly messageId: string }
  | { readonly type: "stop" | "view" }
  | { readonly type: "stream"; readonly after?: SessionEventCursor };

export type AppCommandEnvelope<Message = unknown> = {
  readonly protocolVersion: 2;
  /** Submission identity for dispatch/steer/request; command identity otherwise. */
  readonly id: string;
  readonly workspace: WorkspaceSelector;
} & (
  | { readonly session: { readonly id: string }; readonly command: SessionCommand<Message> }
  | { readonly session: null; readonly command: { readonly type: WorkspaceCommandType } }
);
/** App-scoped environment commands carry no Workspace or Session; kept apart so `AppCommandEnvelope.workspace` stays non-null. */
export type AppEnvironmentEnvelope = {
  readonly protocolVersion: 2;
  readonly id: string;
  readonly workspace: null;
  readonly session: null;
  readonly command: EnvironmentCommand;
};

export interface SessionEventCursor {
  readonly streamId: string;
  readonly sequence: number;
}

export interface SessionStreamOptions {
  readonly after?: SessionEventCursor;
  readonly signal?: AbortSignal;
}

export interface SessionEvent<Event> {
  readonly cursor: SessionEventCursor;
  readonly sessionId: string;
  readonly messageId: string;
  readonly createdAt: Date;
  readonly data: Event;
}
