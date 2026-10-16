/// <reference types="node" />
import type { Readable, Writable } from "node:stream";
import type { SessionIdentity } from "./resources.js";

/**
 * Workspace-scoped native CLI authentication. Sign-in happens in the native CLI's
 * own process. Structured link/code login keeps native output private; the optional
 * low-level terminal relay forwards raw bytes without parsing them.
 */
export type AuthCommand =
  | { readonly type: "login"; readonly force?: boolean }
  | { readonly type: "code"; readonly attemptId: string; readonly code: string }
  | { readonly type: "cancel"; readonly attemptId: string }
  | { readonly type: "status" }
  | { readonly type: "logout" }
  | { readonly type: "terminal" }
  | { readonly type: "close"; readonly terminalId: string };

export type AuthResult =
  | { readonly type: "login"; readonly attemptId: string; readonly url: string; readonly expiresAt: string; readonly userCode?: string }
  | { readonly type: "cancelled"; readonly attemptId: string }
  | { readonly type: "error"; readonly code: string }
  | { readonly type: "status"; readonly authenticated: boolean }
  | { readonly type: "terminal"; readonly terminalId: string; readonly ticket: string; readonly expiresAt: string }
  | { readonly type: "closed"; readonly terminalId: string };

/** Reserved backend protocol placeholder; the Edge scopes it to the canonical Workspace. */
export const AUTH_SESSION_ID = "cantelop-native-auth";
/** Auth commands keep no idle window: runtime quiescence alone holds the Sandbox while a login or unsubmitted code attempt exists. */
export const AUTH_KEEP_ALIVE_SECONDS = 0;
const WORKSPACE_ID_PATTERN = /^wsp_[0-9a-f]{32}$/;
/** Logical Session IDs are App-wide, so each Workspace needs its own stable auth actor. */
export function workspaceAuthSessionID(workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new TypeError("Invalid auth Workspace ID");
  return `${AUTH_SESSION_ID}-${workspaceId}`;
}
/** Workspace auth actors; with a workspaceId, the actor must also belong to that Workspace. */
export function isAuthSessionID(id: string, workspaceId?: string): boolean {
  const suffix = id.slice(AUTH_SESSION_ID.length + 1);
  return id.startsWith(`${AUTH_SESSION_ID}-`) && WORKSPACE_ID_PATTERN.test(suffix) &&
    (workspaceId === undefined || suffix === workspaceId);
}
/** Ordinary Sessions can use neither the backend placeholder nor a Workspace auth actor. */
export function isReservedAuthSessionID(id: string): boolean {
  return id === AUTH_SESSION_ID || isAuthSessionID(id);
}
/** WebSocket subprotocol; the ticket travels as the second offered subprotocol, never in the URL. */
export const AUTH_TERMINAL_PROTOCOL = "cantelop-terminal.v1";
export const LOGIN_ID_PATTERN = /^lgn_[0-9a-f]{32}$/;
export const TERMINAL_ID_PATTERN = /^trm_[0-9a-f]{32}$/;
export const TERMINAL_TICKET_PATTERN = /^[0-9a-f]{64}$/;
/** Marks a compiled-away provider in backend and Edge builds. */
export const COMPILED_AUTH = Symbol.for("dev.cantelop.sdk.compiled-auth.v1");

export interface AuthContext {
  readonly signal: AbortSignal;
  readonly session: SessionIdentity;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A spawned native login process, usually a PTY wrapper around the stock CLI. */
export interface AuthTerminalProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  /** Optional PTY resize, driven by the user's terminal. */
  resize?(columns: number, rows: number): void;
}

/** Declared with `auth` on `cantelop.app({...})`; runs only in the Workspace auth Sandbox. */
export interface NativeCodeLogin {
  link(output: string): string | undefined;
  /** Device flow: display this code on the provider's page; no terminal input is accepted. */
  userCode?(output: string): string | undefined;
  promptCount(output: string): number;
  input(code: string): string;
}
export interface AppAuth {
  /** Provider-specific parsing; SDK owns attempts, timeout, code submission and cleanup. */
  readonly codeLogin?: NativeCodeLogin;
  status(context: AuthContext): boolean | Promise<boolean>;
  logout(context: AuthContext): void | Promise<void>;
  /** Spawns the native CLI's interactive login. Return the process immediately after spawning it. */
  terminal(context: AuthContext): AuthTerminalProcess | Promise<AuthTerminalProcess>;
}

export function isAppAuth(value: unknown): value is AppAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const auth = value as Record<PropertyKey, unknown>;
  if (auth[COMPILED_AUTH] === true) return true;
  if (!["status", "logout", "terminal"].every(key => typeof auth[key] === "function")) return false;
  if (auth.codeLogin === undefined) return true;
  const adapter = auth.codeLogin as Record<string, unknown> | null;
  return !!adapter && typeof adapter === "object" && ["link","promptCount","input"].every(key => typeof adapter[key] === "function") &&
    (adapter.userCode === undefined || typeof adapter.userCode === "function");
}
