import type { WorkspaceDatabase } from "./database.js";
import type { MessageRef, SessionRequestOptions, Workspace } from "./resources.js";

/** Exactly one canonical ID or App-scoped slug. */
export type WorkspaceSelector =
  | { readonly id: string; readonly slug?: never }
  | { readonly slug: string; readonly id?: never };

export interface IntegrationSessionOptions {
  readonly id?: string;
  readonly keepAliveSeconds: number;
}

/** A trusted, App-bound connection supplied by the platform or local CLI. */
export interface AppConnection {
  /** Requests use the private runtime origin; the connection owns routing and authentication. */
  fetch(request: Request): Promise<Response>;
  /** Reserved for local CLI database connections. */
  readonly localDatabaseOrigin?: string;
}

export interface CreateAppOptions {
  readonly connection: AppConnection;
}

export interface App<Message, Event = unknown, Reply = unknown, Steering = unknown> {
  workspace(selector: WorkspaceSelector): WorkspaceRef<Message, Event, Reply, Steering>;
}

export interface WorkspaceRef<Message, Event = unknown, Reply = unknown, Steering = unknown> {
  readonly selector: WorkspaceSelector;
  /** Resolves/provisions a slug, or retrieves an existing canonical ID. */
  resolve(): Promise<Workspace>;
  database(): Promise<WorkspaceDatabase>;
  /** A lazy reference; omitting id generates a fresh App-scoped identity. */
  session(options: IntegrationSessionOptions): SessionRef<Message, Event, Reply, Steering>;
}

export interface SessionRef<Message, Event = unknown, Reply = unknown, Steering = unknown> {
  readonly id: string;
  readonly workspace: WorkspaceSelector;
  readonly keepAliveSeconds: number;
  dispatch(message: Message): Promise<MessageRef>;
  request(message: Message, options?: SessionRequestOptions): Promise<Reply>;
  /** Explicit resume only; ending this subscription never cancels agent work. */
  stream(options?: SessionStreamOptions): AsyncIterable<SessionEvent<Event>>;
  /** Ordered control intake; requires platform/runtime steering capability. */
  steer(input: Steering, options?: SessionControlOptions): Promise<MessageRef>;
  /** Cooperative cancellation; acceptance is not cancellation completion. */
  abort(options?: SessionControlOptions): Promise<MessageRef>;
  /** Read-only platform snapshot; never provisions or activates. */
  view(options?: { readonly signal?: AbortSignal }): Promise<SessionView>;
  /** Releases the Sandbox. This identity remains reusable. */
  stop(): Promise<void>;
}

export interface SessionControlOptions {
  /** Reuse this identity to retry an ambiguous control safely. */
  readonly id?: string;
  readonly signal?: AbortSignal;
}

export interface SessionCapabilities {
  readonly steer: boolean;
  readonly abort: boolean;
}

export interface SessionView {
  readonly id: string;
  readonly state: "unmaterialized" | "active" | "idle";
  readonly workspaceId?: string;
  readonly observedAt: Date;
  readonly capabilities: SessionCapabilities;
}

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
