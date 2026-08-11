import type { App } from "./app.js";
import type { ExecutionEnvironment } from "./execution.js";

export interface ApiContext<Input, Output, Event = never> {
  readonly execution: ExecutionEnvironment<Input, Output, Event>;
}

export interface ApiDefinition<Input, Output, Event = never> {
  create(
    context: ApiContext<Input, Output, Event>,
  ): App<Input, Output, Event>;
}

export type ApiFactory<Input, Output, Event = never> = (
  context: ApiContext<Input, Output, Event>,
) => App<Input, Output, Event>;

/** Defines an Edge API whose execution transport is injected by Cantelop. */
export function defineApi<Input, Output, Event = never>(
  factory: ApiFactory<Input, Output, Event>,
): ApiDefinition<Input, Output, Event> {
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
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";
