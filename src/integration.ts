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

export interface App<Message, Event = unknown, Reply = unknown> {
  workspace(selector: WorkspaceSelector): WorkspaceRef<Message, Event, Reply>;
}

export interface WorkspaceRef<Message, Event = unknown, Reply = unknown> {
  readonly selector: WorkspaceSelector;
  /** Resolves/provisions a slug, or retrieves an existing canonical ID. */
  resolve(): Promise<Workspace>;
  database(): Promise<WorkspaceDatabase>;
  /** A lazy reference; omitting id generates a fresh App-scoped identity. */
  session(options: IntegrationSessionOptions): SessionRef<Message, Event, Reply>;
}

export interface SessionRef<Message, Event = unknown, Reply = unknown> {
  readonly id: string;
  readonly workspace: WorkspaceSelector;
  readonly keepAliveSeconds: number;
  dispatch(message: Message): Promise<MessageRef>;
  request(message: Message, options?: SessionRequestOptions): Promise<Reply>;
  /** Releases the Sandbox. This identity remains reusable. */
  stop(): Promise<void>;
}
