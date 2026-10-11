import type { App } from "./app.js";

export interface WebhookContext<Message = unknown, Event = never, Reply = never, View = never> {
  readonly request: Request;
  /** The current App, using the same Workspace/Session interface as backend code. */
  readonly app: App<Message, Event, Reply, View>;
  /** Reads a declared secret from this App's Edge bindings. */
  secret(name: string): string;
}
export type WebhookHandler<Message = unknown, Event = never, Reply = never, View = never> =
  (context: WebhookContext<Message, Event, Reply, View>) => Response | Promise<Response>;
export interface WebhookRoute<Message = unknown, Event = never, Reply = never, View = never> {
  readonly method: "GET" | "POST";
  readonly handle: WebhookHandler<Message, Event, Reply, View>;
}
export type WebhookRoutes<Message = unknown, Event = never, Reply = never, View = never> =
  Readonly<Record<string, WebhookRoute<Message, Event, Reply, View>>>;

/** Exact paths under the reserved webhook prefix; no general-purpose router. */
export function validateWebhookRoutes(value: WebhookRoutes<any, any, any, any> | undefined): WebhookRoutes<any, any, any, any> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid App webhooks");
  const routes: Record<string, WebhookRoute<any, any, any, any>> = {};
  for (const [path, route] of Object.entries(value)) {
    if (!/^\/webhooks\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path) || !route || typeof route !== "object" || Array.isArray(route) ||
        Object.keys(route).some(key => !["method", "handle"].includes(key)) || !["GET", "POST"].includes(route.method) || typeof route.handle !== "function") throw new TypeError("Invalid App webhook route");
    routes[path] = Object.freeze({ method: route.method, handle: route.handle });
  }
  return Object.freeze(routes);
}
