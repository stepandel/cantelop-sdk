import type { ApiDefinition, ApiEnvironment } from "./api.js";
import {
  createRemoteApp,
  type RemoteAppOptions,
} from "./remote-app.js";
import type { Router } from "./router.js";

export interface EdgeApiWorker {
  fetch(request: Request, bindings?: Readonly<Record<string, unknown>>): Promise<Response>;
}

const CUSTOMER_BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_BINDING_PREFIX = "CANTELOP_";

/**
 * Adapts a customer API definition to the standard module Worker interface.
 * Cantelop's generated deployment bootstrap calls this function; customer API
 * modules remain provider-neutral.
 */
export function createApiWorker<Input = unknown, Output = unknown>(
  definition: ApiDefinition<Input, Output>,
  options: RemoteAppOptions = {},
): EdgeApiWorker {
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof definition.create !== "function"
  ) {
    throw new TypeError("Invalid Cantelop API definition");
  }

  const app = createRemoteApp<Input, Output>(options);
  const routers = new WeakMap<object, Router>();
  let routerWithoutBindings: Router | undefined;

  const routerFor = (
    bindings: Readonly<Record<string, unknown>> | undefined,
  ): Router => {
    if (bindings === undefined) {
      routerWithoutBindings ??= definition.create({
        app,
        env: Object.freeze({}),
      });
      return routerWithoutBindings;
    }

    const cached = routers.get(bindings);
    if (cached) return cached;
    const router = definition.create({
      app,
      env: customerEnvironment(bindings),
    });
    routers.set(bindings, router);
    return router;
  };

  return Object.freeze({
    fetch(
      request: Request,
      bindings?: Readonly<Record<string, unknown>>,
    ): Promise<Response> {
      return routerFor(bindings).handle(request);
    },
  });
}

function customerEnvironment(
  bindings: Readonly<Record<string, unknown>>,
): ApiEnvironment {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(bindings)) {
    if (
      typeof value === "string" &&
      CUSTOMER_BINDING_NAME.test(name) &&
      !name.startsWith(RESERVED_BINDING_PREFIX)
    ) {
      env[name] = value;
    }
  }
  return Object.freeze(env);
}
