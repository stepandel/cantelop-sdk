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

interface SessionOpenBaseConfig {
  readonly id?: string;
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

export interface ExecutionReceipt {
  readonly id: string;
  readonly status: "queued";
  readonly acceptedAt: Date;
}

export interface Session<Input, Output> {
  readonly id: string;
  execute(input: Input, options?: SessionExecuteOptions): Promise<Output>;
  dispatch(input: Input): Promise<ExecutionReceipt>;
  terminate(): Promise<void>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
  open(config: WorkspaceOpenConfig): Promise<Workspace>;
}

export interface SessionService<Input, Output> {
  open(config: SessionOpenConfig): Session<Input, Output>;
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input, Output> {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input, Output>;
}
