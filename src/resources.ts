import type { WorkspaceDatabase } from "./database.js";

export interface Workspace {
  database(): Promise<WorkspaceDatabase>;
  readonly id: string;
  readonly appId: string;
  readonly slug: string;
  readonly hostname: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt?: Date;
}

export interface MessageExecution {
  readonly phase: "sending" | "accepted" | "running" | "cancelling" | "settled" | "retrying" | "recovering" | "quiescent" | "unavailable";
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

export interface SessionRequestOptions {
  /** Stable identity used to recover the same request after an ambiguous client failure. */
  readonly id?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
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
