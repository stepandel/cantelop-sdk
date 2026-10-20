import type { App } from "./app.js";

export interface AppRequestContext<Message = unknown, Event = never, Reply = never, View = unknown> {
  readonly request: Request;
  /** The current App, using the same Workspace/Session interface as backend code. */
  readonly app: App<Message, Event, Reply, View>;
  /** Declared environment values from this App's Edge bindings, including secrets. */
  readonly env: Readonly<Record<string, string | undefined>>;
}
export type WebhookContext<Message = unknown, Event = never, Reply = never, View = unknown> = AppRequestContext<Message, Event, Reply, View>;
export type HomepageHandler<Message = unknown, Event = never, Reply = never, View = unknown> =
  (context: AppRequestContext<Message, Event, Reply, View>) => Response | Promise<Response>;
export type WebhookHandler<Message = unknown, Event = never, Reply = never, View = unknown> =
  (context: WebhookContext<Message, Event, Reply, View>) => Response | Promise<Response>;
export interface WebhookRoute<Message = unknown, Event = never, Reply = never, View = unknown> {
  readonly method: "GET" | "POST";
  readonly handle: WebhookHandler<Message, Event, Reply, View>;
}
export type WebhookRoutes<Message = unknown, Event = never, Reply = never, View = unknown> =
  Readonly<Record<string, WebhookRoute<Message, Event, Reply, View>>>;

const WEBHOOK_PATH = /^\/webhooks\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const WEBHOOK_METHODS: ReadonlySet<unknown> = new Set(["GET", "POST"]);

/** An exact path under the reserved webhook prefix and a supported method; no general-purpose router. */
export function isValidWebhookRoute(path: string, method: unknown): method is WebhookRoute["method"] {
  return WEBHOOK_PATH.test(path) && WEBHOOK_METHODS.has(method);
}

export function validateWebhookRoutes<Message, Event, Reply, View>(value: WebhookRoutes<Message, Event, Reply, View> | undefined): WebhookRoutes<Message, Event, Reply, View> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid App webhooks");
  const routes: Record<string, WebhookRoute<Message, Event, Reply, View>> = {};
  for (const [path, route] of Object.entries(value)) {
    if (!route || typeof route !== "object" || Array.isArray(route) || Object.keys(route).some(key => key !== "method" && key !== "handle") ||
        !isValidWebhookRoute(path, route.method) || typeof route.handle !== "function") throw new TypeError("Invalid App webhook route");
    routes[path] = Object.freeze({ method: route.method, handle: route.handle });
  }
  return Object.freeze(routes);
}
