import type { ApiDefinition, ApiEnvironment } from "./api.js";
import type { App } from "./app.js";
import {
  createRemoteExecutionProvider,
  type RemoteExecutionProviderOptions,
} from "./remote-execution.js";

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
  options: RemoteExecutionProviderOptions = {},
): EdgeApiWorker {
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof definition.create !== "function"
  ) {
    throw new TypeError("Invalid Cantelop API definition");
  }

  const execution = createRemoteExecutionProvider<Input, Output>(options);
  const apps = new WeakMap<object, App<Input, Output>>();
  let appWithoutBindings: App<Input, Output> | undefined;

  const appFor = (
    bindings: Readonly<Record<string, unknown>> | undefined,
  ): App<Input, Output> => {
    if (bindings === undefined) {
      appWithoutBindings ??= definition.create({
        execution,
        env: Object.freeze({}),
      });
      return appWithoutBindings;
    }

    const cached = apps.get(bindings);
    if (cached) return cached;
    const app = definition.create({
      execution,
      env: customerEnvironment(bindings),
    });
    apps.set(bindings, app);
    return app;
  };

  return Object.freeze({
    fetch(
      request: Request,
      bindings?: Readonly<Record<string, unknown>>,
    ): Promise<Response> {
      return appFor(bindings).handle(request);
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
