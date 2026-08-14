export type HttpMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

export interface RouteContext {
  readonly request: Request;
}

export type RouteHandler = (
  context: RouteContext,
) => Response | Promise<Response>;

export interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler;
}

export interface Router {
  route(method: HttpMethod, path: string, handler: RouteHandler): Router;
  routes(routes: readonly Route[]): Router;
  handle(request: Request): Promise<Response>;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new TypeError(`Route path must start with "/": ${path}`);
  }

  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function createRouter(): Router {
  const registered = new Map<string, RouteHandler>();
  const router: Router = {
    route(method, path, handler) {
      const key = `${method} ${normalizePath(path)}`;

      if (registered.has(key)) {
        throw new Error(`Route already registered: ${key}`);
      }

      registered.set(key, handler);
      return router;
    },

    routes(routes) {
      for (const route of routes) {
        router.route(route.method, route.path, route.handler);
      }

      return router;
    },

    async handle(request) {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);
      const method = request.method.toUpperCase() as HttpMethod;
      const handler = registered.get(`${method} ${path}`);

      if (handler) return handler({ request });

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

  return router;
}
