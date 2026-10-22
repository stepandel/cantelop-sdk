import { assertRuntimeID } from "./session-runtime-contract.js";
import { EDGE_ORIGIN } from "./shared.js";
import { AppConfigurationError, resolveAppConfiguration, type ConfigurationContext, type NormalizedAppOptions } from "./app-config.js";
import type { AppConnection } from "./integration.js";

const EDGE_HOST = new URL(EDGE_ORIGIN).host;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Assigns the logical Edge origin (and any SDK headers) to a request before it leaves the SDK.
 * An already-addressed request without extra headers passes through unchanged; otherwise it is copied once.
 */
export function edgeRequest(request: Request, headers: Readonly<Record<string, string>> = {}): Request {
  const url = new URL(request.url);
  const names = Object.keys(headers);
  if (url.host === EDGE_HOST && names.length === 0) return request;
  url.host = EDGE_HOST;
  const addressed = new Request(url, request);
  for (const name of names) addressed.headers.set(name, headers[name]!);
  return addressed;
}

export function createEdgeConnection(options: { readonly edgeUrl?: string; readonly accessToken?: string; readonly runtimeId?: string } | undefined, transport: { readonly streamRequestBody?: boolean } = {}): AppConnection {
  if (!options?.edgeUrl || !options.accessToken || /[\r\n]/.test(options.accessToken)) {
    throw new TypeError("An App Edge URL and access token are required");
  }
  const origin = new URL(options.edgeUrl);
  const loopback = LOOPBACK_HOSTS.has(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("App Edge URL must be an HTTPS origin (HTTP loopback is allowed for local dev)");
  }
  const token = options.accessToken;
  const runtimeId = options.runtimeId;
  if (runtimeId !== undefined) assertRuntimeID(runtimeId);
  return Object.freeze({
    async fetch(request: Request) {
      const source = new URL(request.url);
      const target = new URL(origin);
      target.pathname = source.pathname;
      target.search = source.search;
      const headers = new Headers(request.headers);
      if (!headers.has("X-Cantelop-Session-Runtime") && runtimeId !== undefined) headers.set("X-Cantelop-Session-Runtime", runtimeId);
      headers.set("Authorization", `Bearer ${token}`);
      // Commands keep Content-Length; service relays can preserve streaming sync uploads.
      return fetch(new Request(target, {
        method: request.method, headers, signal: request.signal, redirect: "manual",
        ...(request.body === null ? {} : transport.streamRequestBody ? { body: request.body, duplex: "half" } as RequestInit : { body: await request.arrayBuffer() }),
      }));
    },
  });
}

/** Capture configuration at construction; resolve files lazily on first operation. */
export function resolveEdgeConnection(options: Pick<NormalizedAppOptions, "name" | "connection" | "edgeUrl" | "accessToken">, context: ConfigurationContext, profile?: string): AppConnection {
  if (options.connection !== undefined) return options.connection;
  if (options.edgeUrl !== undefined) return createEdgeConnection(options);
  const selection = { slug: options.name, ...(profile === undefined ? {} : { profile }) };
  let pending: Promise<AppConnection> | undefined;
  return Object.freeze({
    async fetch(request: Request) {
      request.signal.throwIfAborted();
      pending ??= resolveAppConfiguration(selection, context).then(createEdgeConnection).catch(error => {
        pending = undefined;
        if (error instanceof AppConfigurationError) throw error;
        throw new AppConfigurationError("app_configuration_invalid");
      });
      const connection = await pending;
      request.signal.throwIfAborted();
      return connection.fetch(request);
    },
    ...(context.localDatabaseOrigin === undefined ? {} : { localDatabaseOrigin: context.localDatabaseOrigin }),
  });
}
