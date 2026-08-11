import type { ExecutionEnvironment } from "./execution.js";

export type HttpMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

export interface RouteContext<Input, Output, Event = never> {
  readonly request: Request;
  readonly execution: ExecutionEnvironment<Input, Output, Event>;
}

export type RouteHandler<Input, Output, Event = never> = (
  context: RouteContext<Input, Output, Event>,
) => Response | Promise<Response>;

export interface Route<Input, Output, Event = never> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler<Input, Output, Event>;
}

export interface AppOptions<Input, Output, Event = never> {
  readonly execution: ExecutionEnvironment<Input, Output, Event>;
}

export interface App<Input, Output, Event = never> {
  route(
    method: HttpMethod,
    path: string,
    handler: RouteHandler<Input, Output, Event>,
  ): App<Input, Output, Event>;
  routes(
    routes: readonly Route<Input, Output, Event>[],
  ): App<Input, Output, Event>;
  handle(request: Request): Promise<Response>;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new TypeError(`Route path must start with "/": ${path}`);
  }

  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function createApp<
  Input = unknown,
  Output = unknown,
  Event = never,
>(
  options: AppOptions<Input, Output, Event>,
): App<Input, Output, Event> {
  const registered = new Map<string, RouteHandler<Input, Output, Event>>();
  const app: App<Input, Output, Event> = {
    route(method, path, handler) {
      const key = `${method} ${normalizePath(path)}`;

      if (registered.has(key)) {
        throw new Error(`Route already registered: ${key}`);
      }

      registered.set(key, handler);
      return app;
    },

    routes(routes) {
      for (const route of routes) {
        app.route(route.method, route.path, route.handler);
      }

      return app;
    },

    async handle(request) {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);
      const method = request.method.toUpperCase() as HttpMethod;
      const handler = registered.get(`${method} ${path}`);

      if (handler) {
        return handler({ request, execution: options.execution });
      }

      const allowed = [...registered.keys()]
        .filter((key) => key.endsWith(` ${path}`))
        .map((key) => key.slice(0, key.indexOf(" ")));

      if (allowed.length > 0) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: allowed.sort().join(", ") },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  };

  return app;
}
