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

export interface SessionOpenByIDConfig extends SessionOpenBaseConfig {
  readonly workspaceId: string;
  readonly workspaceSlug?: never;
}

export interface SessionOpenBySlugConfig extends SessionOpenBaseConfig {
  readonly workspaceId?: never;
  readonly workspaceSlug: string;
}

export type SessionOpenConfig = SessionOpenByIDConfig | SessionOpenBySlugConfig;

export interface MessageExecution {
 readonly phase: "sending" | "accepted" | "running" | "cancelling" | "settled" | "quiescent" | "unavailable";
 readonly outcome: "pending" | "succeeded" | "failed" | "timed_out" | "unknown";
 readonly sandboxId: string;
 readonly deadline: Date;
 readonly phaseAt: Date;
 readonly workState: string;
}

export interface AcceptedMessageStatus {
 readonly execution?: MessageExecution;
  readonly state: "accepted";
  readonly acceptedAt: Date;
}

export interface HandlingMessageStatus {
 readonly execution?: MessageExecution;
  readonly state: "handling";
  readonly acceptedAt: Date;
  readonly startedAt: Date;
}

export interface HandledMessageStatus {
 readonly execution?: MessageExecution;
  readonly state: "handled";
  readonly acceptedAt: Date;
  readonly startedAt: Date;
  readonly handledAt: Date;
}

export interface FailedMessageStatus {
 readonly execution?: MessageExecution;
  readonly state: "failed";
  readonly acceptedAt: Date;
  readonly startedAt: Date;
  readonly failedAt: Date;
  readonly error: Readonly<{ code: string }>;
}

export interface UnknownMessageStatus {
  readonly state: "unknown";
}

export type MessageStatus =
  | AcceptedMessageStatus
  | HandlingMessageStatus
  | HandledMessageStatus
  | FailedMessageStatus
  | UnknownMessageStatus;

/** A reference to an accepted message. */
export interface MessageRef {
  readonly id: string;
  readonly state: "accepted";
  readonly acceptedAt: Date;
  status(): Promise<MessageStatus>;
}

/** Canonical, read-only identity and configuration for a Session actor. */
export interface SessionIdentity {
  readonly id: string;
  /** Present when the Session was opened with a canonical Workspace ID. */
  readonly workspaceId?: string;
  /** Present when the Session will lazily resolve an App-scoped Workspace slug. */
  readonly workspaceSlug?: string;
  readonly keepAliveSeconds: number;
}

/** A reference to a Session actor. */
export interface Session<Message> extends SessionIdentity {
  dispatch(message: Message): Promise<MessageRef>;
  /** Adapts an authenticated App GET route to SSE or an output-only WebSocket. */
  events(request: Request): Promise<Response>;
}

export interface WorkspaceService {
  create(config: WorkspaceCreateConfig): Promise<Workspace>;
  open(config: WorkspaceOpenConfig): Promise<Workspace>;
}

export interface SessionService<Input> {
  open(config: SessionOpenByIDConfig): Session<Input> & { readonly workspaceId: string };
  open(config: SessionOpenBySlugConfig): Session<Input> & { readonly workspaceSlug: string };
}

/** Capabilities of the current App, injected by Cantelop. */
export interface CantelopApp<Input> {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService<Input>;
}
