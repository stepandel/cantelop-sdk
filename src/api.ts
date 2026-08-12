import type { App } from "./app.js";
import type { ExecutionProvider } from "./execution.js";

export interface ApiContext<Input, Output> {
  readonly execution: ExecutionProvider<Input, Output>;
}

export interface ApiDefinition<Input, Output> {
  create(
    context: ApiContext<Input, Output>,
  ): App<Input, Output>;
}

export type ApiFactory<Input, Output> = (
  context: ApiContext<Input, Output>,
) => App<Input, Output>;

/** Defines an Edge API whose execution transport is injected by Cantelop. */
export function defineApi<Input, Output>(
  factory: ApiFactory<Input, Output>,
): ApiDefinition<Input, Output> {
  return Object.freeze({ create: factory });
}

export { createApp } from "./app.js";
export type {
  App,
  AppOptions,
  HttpMethod,
  Route,
  RouteContext,
  RouteHandler,
} from "./app.js";
export type {
  Execution,
  ExecutionEnvironment,
  ExecutionProvider,
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";
export {
  RemoteExecutionError,
  createRemoteExecutionProvider,
} from "./remote-execution.js";
export type { RemoteExecutionProviderOptions } from "./remote-execution.js";
