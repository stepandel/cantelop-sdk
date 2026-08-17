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

export interface SessionCreateConfig {
  readonly workspaceId: string;
  readonly keepAliveSeconds: number;
}

interface SessionOpenBaseConfig {
  readonly key: string;
  readonly keepAliveSeconds: number;
}

export type SessionOpenConfig = SessionOpenBaseConfig & (
  | { readonly workspaceId: string; readonly workspace?: never }
  | { readonly workspace: string; readonly workspaceId?: never }
  | { readonly workspace?: never; readonly workspaceId?: never }
);

export interface SessionExecuteOptions {
  readonly signal?: AbortSignal;
}

export interface AsyncExecutionDispatch<Input> {
  readonly workspaceId: string;
  readonly sessionKey: string;
  readonly keepAliveSeconds: number;
  readonly input: Input;
}

export interface AsyncExecutionReceipt {
  readonly id: string;
  readonly status: "queued";
  readonly acceptedAt: Date;
}

export interface Session<Input, Output> {
  readonly id: string;
  execute(input: Input, options?: SessionExecuteOptions): Promise<Output>;
  terminate(): Promise<void>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
  open(config: WorkspaceOpenConfig): Promise<Workspace>;
}

export interface SessionService<Input, Output> {
  create(config: SessionCreateConfig): Promise<Session<Input, Output>>;
  open(config: SessionOpenConfig): Promise<Session<Input, Output>>;
  connect(sessionId: string): Session<Input, Output>;
}

export interface ExecutionService<Input> {
  dispatch(config: AsyncExecutionDispatch<Input>): Promise<AsyncExecutionReceipt>;
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input, Output> {
  readonly executions: ExecutionService<Input>;
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input, Output>;
}
