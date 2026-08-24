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

export interface SessionExecuteOptions {
  readonly signal?: AbortSignal;
}

export interface ExecutionReceipt {
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
export interface SessionHandle<Input, Output> extends Session {
  execute(input: Input, options?: SessionExecuteOptions): Promise<Output>;
  dispatch(input: Input): Promise<ExecutionReceipt>;
  steer(input: Input): Promise<ExecutionReceipt>;
  terminate(): Promise<void>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
  open(config: WorkspaceOpenConfig): Promise<Workspace>;
}

export interface SessionService<Input, Output> {
  open(config: SessionOpenConfig): SessionHandle<Input, Output>;
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input, Output> {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input, Output>;
}
