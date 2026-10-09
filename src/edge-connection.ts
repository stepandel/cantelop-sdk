import type { AppConnection } from "./integration.js";

export const EDGE_ORIGIN = "https://edge.cantelop.internal";
export const EDGE_PREFIX = "/__cantelop/app/v1";

/** Converts private serializers into the App Edge wire protocol. */
export function edgeRequest(request: Request): Request {
  const url = new URL(request.url);
  url.host = new URL(EDGE_ORIGIN).host;
  if (url.pathname.startsWith("/__cantelop/v1/")) {
    url.pathname = EDGE_PREFIX + url.pathname.slice("/__cantelop/v1".length);
  }
  return new Request(url, request);
}

export function createEdgeConnection(options: { readonly edgeUrl?: string; readonly accessToken?: string } | undefined): AppConnection {
  if (!options?.edgeUrl || !options.accessToken || /[\r\n]/.test(options.accessToken)) {
    throw new TypeError("An App Edge URL and access token are required");
  }
  const origin = new URL(options.edgeUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("App Edge URL must be an HTTPS origin (HTTP loopback is allowed for local dev)");
  }
  const token = options.accessToken;
  return Object.freeze({
    async fetch(request: Request) {
      const source = new URL(request.url);
      const target = new URL(source.pathname + source.search, origin);
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(new Request(target, { ...{ method: request.method, headers, signal: request.signal, redirect: "manual" as const },
        ...(request.body === null ? {} : { body: await request.arrayBuffer() }),
      }));
    },
  });
}
