import type { D1Database } from "@cloudflare/workers-types";
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
export function createApiWorker<Input = unknown>(
  definition: ApiDefinition<Input>,
  options: RemoteAppOptions = {},
): EdgeApiWorker {
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof definition.create !== "function"
  ) {
    throw new TypeError("Invalid Cantelop API definition");
  }

  const app = createRemoteApp<Input>(options);
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
    const db = customerDatabase(bindings);
    const router = definition.create({
      app,
      env: customerEnvironment(bindings),
      ...(db === undefined ? {} : { db }),
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

function customerDatabase(bindings: Readonly<Record<string, unknown>>): D1Database | undefined {
  const value = bindings.DB;
  // Legacy string variables named DB remain valid until database enablement.
  if (value === undefined || typeof value === "string") return undefined;
  if (value === null || typeof value !== "object" ||
      !["prepare", "batch", "exec", "withSession"].every(
        (method) => typeof (value as Record<string, unknown>)[method] === "function",
      )) throw new TypeError("Invalid Cantelop database binding");
  return value as D1Database;
}
