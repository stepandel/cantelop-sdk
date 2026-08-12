import type { ApiDefinition } from "./api.js";
import {
  createRemoteExecutionProvider,
  type RemoteExecutionProviderOptions,
} from "./remote-execution.js";

export interface EdgeApiWorker {
  fetch(request: Request): Promise<Response>;
}

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

  const app = definition.create({
    execution: createRemoteExecutionProvider<Input, Output>(options),
  });
  return Object.freeze({
    fetch(request: Request): Promise<Response> {
      return app.handle(request);
    },
  });
}
