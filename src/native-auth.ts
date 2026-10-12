/// <reference types="node" />
import type { Readable, Writable } from "node:stream";
import type { SessionIdentity } from "./resources.js";

/**
 * Workspace-scoped native CLI authentication. Sign-in happens in the native CLI's
 * own terminal: the SDK relays its bytes to the user and never parses or stores them.
 */
export type AuthCommand =
  | { readonly type: "status" }
  | { readonly type: "logout" }
  | { readonly type: "terminal" }
  | { readonly type: "close"; readonly terminalId: string };

export type AuthResult =
  | { readonly type: "status"; readonly authenticated: boolean }
  | { readonly type: "terminal"; readonly terminalId: string; readonly ticket: string; readonly expiresAt: string }
  | { readonly type: "closed"; readonly terminalId: string };

/** Ordinary Sessions cannot use this ID; it addresses the Workspace auth runtime. */
export const AUTH_SESSION_ID = "cantelop-native-auth";
/** WebSocket subprotocol; the ticket travels as the second offered subprotocol, never in the URL. */
export const AUTH_TERMINAL_PROTOCOL = "cantelop-terminal.v1";
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
  /** Optional PTY resize, driven by the user's terminal. */
  resize?(columns: number, rows: number): void;
}

/** Declared with `auth` on `cantelop.app({...})`; runs only in the Workspace auth Sandbox. */
export interface AppAuth {
  status(context: AuthContext): boolean | Promise<boolean>;
  logout(context: AuthContext): void | Promise<void>;
  /** Spawns the native CLI's interactive login. Return the process immediately after spawning it. */
  terminal(context: AuthContext): AuthTerminalProcess | Promise<AuthTerminalProcess>;
}

export function isAppAuth(value: unknown): value is AppAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const auth = value as Record<PropertyKey, unknown>;
  return auth[COMPILED_AUTH] === true || ["status", "logout", "terminal"].every(key => typeof auth[key] === "function");
}
