import type { SessionRuntime } from "./session-runtime-contract.js";
import type { WorkspaceDatabase } from "./database.js";
import type { MessageRef, SessionRequestOptions, Workspace } from "./resources.js";

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

export type CantelopClientOptions<Message = unknown, Event = never, Reply = never> = {
  readonly sessionRuntime: SessionRuntime<Message, Event, Reply>;
} & (
  | ((AppSelector | { readonly id?: never; readonly slug?: never }) & {
      readonly profile?: string;
      readonly connection?: never;
      readonly edgeUrl?: never;
      readonly accessToken?: never;
    })
  | { readonly connection: AppConnection; readonly edgeUrl?: never; readonly accessToken?: never; readonly id?: never; readonly slug?: never; readonly profile?: never }
  | { readonly edgeUrl: string; readonly accessToken: string; readonly connection?: never; readonly id?: never; readonly slug?: never; readonly profile?: never }
);

export interface WorkspaceRef<Message, Event = unknown, Reply = unknown, View = unknown> {
  readonly selector: WorkspaceSelector;
  /** Resolves/provisions a slug, or retrieves an existing canonical ID. */
  resolve(): Promise<Workspace>;
  database(): Promise<WorkspaceDatabase>;
  /** A lazy reference; omitting id generates a fresh App-scoped identity. */
  session(options?: IntegrationSessionOptions): SessionRef<Message, Event, Reply, View>;
}

export interface SessionRef<Message, Event = unknown, Reply = unknown, View = unknown> {
  readonly id: string;
  readonly workspace: WorkspaceSelector;
  readonly keepAliveSeconds?: number;
  dispatch(message: Message, options?: SessionSubmissionOptions): Promise<MessageRef>;
  request(message: Message, options?: SessionRequestOptions): Promise<Reply>;
  /** Explicit resume only; ending this subscription never cancels agent work. */
  stream(options?: SessionStreamOptions): AsyncIterable<SessionEvent<Event>>;
  /** Priority message admission; preserves order within each priority. */
  steer(message: Message, options?: SessionSubmissionOptions): Promise<MessageRef>;
  /** Cooperative cancellation; acceptance is not cancellation completion. */
  cancel(messageId: string, options?: SessionCommandOptions): Promise<MessageCancellation>;
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

export interface MessageCancellation {
  readonly messageId: string;
  /** requested means cooperative cancellation was admitted, not completed. */
  readonly state: "requested" | "cancelled" | "settled";
  readonly status?: import("./resources.js").MessageStatus;
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
  | { readonly type: "dispatch" | "steer"; readonly message: Message; readonly keepAliveSeconds?: number }
  | { readonly type: "request"; readonly message: Message; readonly keepAliveSeconds?: number; readonly timeoutMs: number }
  | { readonly type: "cancel" | "status"; readonly messageId: string }
  | { readonly type: "stop" | "view" }
  | { readonly type: "stream"; readonly after?: SessionEventCursor };

export type AppCommandEnvelope<Message = unknown> = {
  readonly protocolVersion: 2;
  /** Submission identity for dispatch/steer/request; command identity otherwise. */
  readonly id: string;
  readonly workspace: WorkspaceSelector;
} & (
  | { readonly session: { readonly id: string }; readonly command: SessionCommand<Message> }
  | { readonly session: null; readonly command: { readonly type: "workspace.resolve" | "workspace.database" } }
);

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
