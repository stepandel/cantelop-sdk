/// <reference types="node" />
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { AUTH_TERMINAL_PROTOCOL, TERMINAL_ID_PATTERN, TERMINAL_TICKET_PATTERN } from "./native-auth.js";
import { acceptTerminalSocket, refuseUpgrade } from "./terminal-socket.js";

export interface AuthTerminalBridgeOptions {
  /**
   * Sends a request to the Workspace's auth Sandbox runtime. The caller routes by
   * Workspace and adds its Sandbox binding (X-Cantelop-Sandbox-ID); it must not log bodies.
   */
  readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
}

const REASONS: Readonly<Record<number, string>> = { 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 410: "Gone" };

/**
 * Platform-side relay for the browser's auth terminal: terminates the WebSocket and
 * speaks the Sandbox's HTTP terminal routes. Terminal bytes are forwarded, never stored.
 */
export async function bridgeAuthTerminal(request: IncomingMessage, socket: Duplex, head: Buffer, terminalId: string, options: AuthTerminalBridgeOptions): Promise<void> {
  socket.on("error", () => undefined);
  const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
  const tickets = offered.filter(value => TERMINAL_TICKET_PATTERN.test(value));
  if (!TERMINAL_ID_PATTERN.test(terminalId) || !offered.includes(AUTH_TERMINAL_PROTOCOL) || tickets.length !== 1) { refuseUpgrade(socket, 401, "Unauthorized"); return; }
  const ticket = tickets[0]!;
  const route = (operation: string) => `/__cantelop/v2/runtime/auth/terminals/${terminalId}/${operation}`;
  const headers = { "X-Cantelop-Terminal-Ticket": ticket };
  const controller = new AbortController();
  let attached: Response;
  try { attached = await options.fetch(route("attach"), { method: "POST", headers, signal: controller.signal }); }
  catch { refuseUpgrade(socket, 502, "Bad Gateway"); return; }
  if (!attached.ok || !attached.body) {
    await attached.body?.cancel().catch(() => undefined);
    const status = REASONS[attached.status] ? attached.status : 502;
    refuseUpgrade(socket, status, REASONS[status] ?? "Bad Gateway");
    return;
  }
  // Input keeps the user's keystroke order.
  let inputs = Promise.resolve();
  const post = (operation: "input" | "resize", body: Buffer | string) => {
    inputs = inputs.then(async () => {
      if (controller.signal.aborted) return;
      const response = await options.fetch(route(operation), { method: "POST", headers, body: typeof body === "string" ? body : new Uint8Array(body), signal: controller.signal });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && response.status !== 400) throw new Error("terminal input rejected");
    }).catch(() => { terminal?.close(1011); });
  };
  const terminal = acceptTerminalSocket(request, socket, head, AUTH_TERMINAL_PROTOCOL, {
    binary: data => post("input", data),
    text: data => {
      let control: { type?: unknown; columns?: unknown; rows?: unknown };
      try { control = JSON.parse(data); } catch { return; }
      if (control?.type === "resize") post("resize", JSON.stringify({ columns: control.columns, rows: control.rows }));
    },
    // Closing the browser ends the attachment, which ends the login in the Sandbox.
    closed: () => controller.abort(),
  });
  if (!terminal) { controller.abort(); return; }
  const reader = attached.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      terminal.send(value);
    }
    terminal.close(1000);
  } catch {
    terminal.close(1011);
  } finally {
    reader.releaseLock();
  }
}
