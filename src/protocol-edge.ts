import { EDGE_PREFIX } from "./edge-connection.js";

/** Internal protocol implementation. Never imported from the application root. */
export interface ProtocolEdgeOptions {
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly runtimeOrigin?: string;
}

const routes: readonly [string, RegExp][] = [
  ["POST", /^\/workspaces\/open$/],
  ["POST", /^\/workspaces\/database\/credentials$/],
  ["GET", /^\/workspaces\/wsp_[0-9a-f]{32}$/],
  ["POST", /^\/(?:messages|requests)$/],
  ["GET", /^\/sessions\/[^/]+\/(?:events|messages\/msg_[0-9a-f]{32})$/],
];
const integrationRoutes: readonly [string, RegExp][] = [
  ["GET", /^\/sessions\/[^/]+$/],
  ["DELETE", /^\/sessions\/[^/]+$/],
  ["POST", /^\/sessions\/[^/]+\/controls$/],
  ["GET", /^\/sessions\/[^/]+\/controls\/msg_[0-9a-f]{32}$/],
];

/** Credential provisioning and trusted App routing are a coordinated platform contract. */
export function createProtocolWorker(options: ProtocolEdgeOptions = {}) {
  const runtimeFetch = options.fetch ?? ((request: Request) => fetch(request));
  const runtimeOrigin = options.runtimeOrigin ?? "https://runtime.cantelop.internal";
  return Object.freeze({
    async fetch(request: Request, bindings: Readonly<Record<string, unknown>> = {}): Promise<Response> {
      const token = bindings.CANTELOP_INTEGRATION_TOKEN;
      if (typeof token !== "string" || !token) return failure("integration_not_configured", 503);
      // Compare fixed-size digests so token length/content does not affect the comparison loop.
      const authorization = request.headers.get("Authorization") ?? "";
      const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      const [expected, actual] = await Promise.all([digest(`Bearer ${token}`), digest(authorization)]);
      const left = new Uint8Array(expected), right = new Uint8Array(actual);
      let difference = 0;
      for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
      if (difference !== 0) return failure("unauthorized", 401);
      const url = new URL(request.url);
      let internalPath: string;
      if (url.pathname.startsWith(EDGE_PREFIX + "/")) {
        const suffix = url.pathname.slice(EDGE_PREFIX.length);
        if (!routes.some(([method, pattern]) => request.method === method && pattern.test(suffix))) return failure("not_found", 404);
        internalPath = "/__cantelop/v1" + suffix;
      } else if (url.pathname.startsWith("/__cantelop/integration/v1/")) {
        const suffix = url.pathname.slice("/__cantelop/integration/v1".length);
        if (!integrationRoutes.some(([method, pattern]) => request.method === method && pattern.test(suffix))) return failure("not_found", 404);
        internalPath = url.pathname;
      } else return failure("not_found", 404);
      const headers = new Headers();
      for (const name of ["content-type", "accept", "last-event-id"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      // The outbound Worker supplies trusted App context; caller headers cannot supply it.
      return runtimeFetch(new Request(new URL(internalPath + url.search, runtimeOrigin), {
        method: request.method, headers, body: request.body, signal: request.signal, redirect: "manual",
        ...(request.body === null ? {} : { duplex: "half" }),
      } as RequestInit));
    },
  });
}
function failure(code: string, status: number): Response { return Response.json({ code }, { status }); }
