import type { CantelopApp } from "./resources.js";
import { createRouter, type Router } from "./router.js";

/** Customer variables and secrets supplied to an Edge API by Cantelop. */
export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export interface ApiContext<Input, Output> {
  readonly app: CantelopApp<Input, Output>;
  readonly env: ApiEnvironment;
  readonly router: Router;
}

type ApiRuntimeContext<Input, Output> = Omit<ApiContext<Input, Output>, "router">;

export interface ApiDefinition<Input, Output> {
  create(
    context: ApiRuntimeContext<Input, Output>,
  ): Router;
}

export type ApiFactory<Input, Output> = (
  context: ApiContext<Input, Output>,
) => void;

/** Defines an Edge API whose current App is injected by Cantelop. */
export function defineApi<Input, Output>(
  factory: ApiFactory<Input, Output>,
): ApiDefinition<Input, Output> {
  return Object.freeze({
    create(context: ApiRuntimeContext<Input, Output>): Router {
      const router = createRouter();
      factory(Object.freeze({ app: context.app, env: context.env, router }));
      return router;
    },
  });
}

export type {
  HttpMethod,
  Route,
  RouteContext,
  RouteHandler,
  Router,
} from "./router.js";
export type {
  AsyncExecutionDispatch,
  AsyncExecutionReceipt,
  CantelopApp,
  ExecutionService,
  Session,
  SessionCreateConfig,
  SessionExecuteOptions,
  SessionOpenConfig,
  SessionService,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceOpenConfig,
  WorkspaceService,
} from "./resources.js";
export { RemoteAppError } from "./remote-app.js";
