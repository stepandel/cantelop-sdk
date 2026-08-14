export interface WorkspaceCreateConfig {
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

export interface SessionCreateConfig {
  readonly workspaceId: string;
  readonly keepAliveSeconds: number;
}

export interface SessionOpenConfig extends SessionCreateConfig {
  readonly key: string;
}

export interface SessionExecuteOptions {
  readonly signal?: AbortSignal;
}

export interface Session<Input, Output> {
  readonly id: string;
  execute(input: Input, options?: SessionExecuteOptions): Promise<Output>;
  terminate(): Promise<void>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
}

export interface SessionService<Input, Output> {
  create(config: SessionCreateConfig): Promise<Session<Input, Output>>;
  open(config: SessionOpenConfig): Promise<Session<Input, Output>>;
  connect(sessionId: string): Session<Input, Output>;
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input, Output> {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input, Output>;
}
