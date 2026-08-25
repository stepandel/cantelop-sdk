export interface WorkspaceCreateConfig {
  readonly slug: string;
}

export interface WorkspaceOpenConfig {
  readonly slug: string;
}

export interface Workspace {
  readonly id: string;
  readonly appId: string;
  readonly slug: string;
  readonly hostname: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt?: Date;
}

export interface SessionOpenConfig {
  readonly id?: string;
  readonly workspaceId: string;
  readonly keepAliveSeconds: number;
}

export interface MessageReceipt {
  readonly id: string;
  readonly status: "queued";
  readonly acceptedAt: Date;
}

/** Canonical, read-only identity and configuration for a Session actor. */
export interface SessionIdentity {
  readonly id: string;
  readonly workspaceId: string;
  readonly keepAliveSeconds: number;
}

/** A reference to a Session actor. */
export interface Session<Message> extends SessionIdentity {
  dispatch(message: Message): Promise<MessageReceipt>;
  terminate(): Promise<void>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
  open(config: WorkspaceOpenConfig): Promise<Workspace>;
}

export interface SessionService<Input> {
  open(config: SessionOpenConfig): Session<Input>;
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input> {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input>;
}
