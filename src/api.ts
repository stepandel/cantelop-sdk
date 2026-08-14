import type { CantelopApp } from "./resources.js";
import type { Router } from "./router.js";

/** Customer variables and secrets supplied to an Edge API by Cantelop. */
export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export interface ApiContext<Input, Output> {
  readonly app: CantelopApp<Input, Output>;
  readonly env: ApiEnvironment;
}

export interface ApiDefinition<Input, Output> {
  create(
    context: ApiContext<Input, Output>,
  ): Router;
}

export type ApiFactory<Input, Output> = (
  context: ApiContext<Input, Output>,
) => Router;

/** Defines an Edge API whose current App is injected by Cantelop. */
export function defineApi<Input, Output>(
  factory: ApiFactory<Input, Output>,
): ApiDefinition<Input, Output> {
  return Object.freeze({ create: factory });
}

export { createRouter } from "./router.js";
export type {
  HttpMethod,
  Route,
  RouteContext,
  RouteHandler,
  Router,
} from "./router.js";
export type {
  CantelopApp,
  Session,
  SessionCreateConfig,
  SessionExecuteOptions,
  SessionService,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceService,
} from "./resources.js";
export { RemoteAppError } from "./remote-app.js";
