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

/** Canonical, read-only Session identity and configuration. */
export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly keepAliveSeconds: number;
}

/** Edge capabilities for operating on a canonical Session. */
export interface SessionHandle<Input> extends Session {
  dispatch(input: Input): Promise<MessageReceipt>;
  terminate(): Promise<void>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
  open(config: WorkspaceOpenConfig): Promise<Workspace>;
}

export interface SessionService<Input> {
  open(config: SessionOpenConfig): SessionHandle<Input>;
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input> {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input>;
}
