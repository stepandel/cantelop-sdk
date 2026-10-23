/** Leaf helpers and protocol constants shared across SDK layers. Imports nothing. */

/** Logical origins the SDK assigns before a request leaves it; never resolved by DNS. */
export const EDGE_ORIGIN = "https://edge.cantelop.internal";
export const RUNTIME_ORIGIN = "https://runtime.cantelop.internal";

export const WORKSPACE_ID_PATTERN = /^wsp_[0-9a-f]{32}$/;
export const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{32}$/;

const opaqueID = () => crypto.randomUUID().replaceAll("-", "");
export const messageID = () => `msg_${opaqueID()}`;
export const sessionID = () => `ses_${opaqueID()}`;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The signal's own reason, or a named AbortError when it was aborted without one. */
export function abortReason(signal: AbortSignal, message: string): unknown {
  return signal.reason ?? new DOMException(message, "AbortError");
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A bare HTTPS origin, or an HTTP loopback origin for local development. */
export function isServiceOrigin(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) &&
    !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}
