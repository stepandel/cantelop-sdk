import type { CantelopApp } from "./resources.js";
import { createRouter, type Router } from "./router.js";

/** Customer variables and secrets supplied to an Edge API by Cantelop. */
export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export interface ApiContext<Input> {
  readonly app: CantelopApp<Input>;
  readonly env: ApiEnvironment;
  readonly router: Router;
}

type ApiRuntimeContext<Input> = Omit<ApiContext<Input>, "router">;

export interface ApiDefinition<Input> {
  create(
    context: ApiRuntimeContext<Input>,
  ): Router;
}

export type ApiFactory<Input> = (
  context: ApiContext<Input>,
) => void;

/** Defines an Edge API whose current App is injected by Cantelop. */
export function defineApi<Input>(
  factory: ApiFactory<Input>,
): ApiDefinition<Input> {
  return Object.freeze({
    create(context: ApiRuntimeContext<Input>): Router {
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
  CantelopApp,
  AcceptedMessageStatus,
  FailedMessageStatus,
  HandledMessageStatus,
  HandlingMessageStatus,
  MessageRef,
  MessageStatus,
  Session,
  SessionIdentity,
  SessionOpenConfig,
  SessionService,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceOpenConfig,
  WorkspaceService,
  UnknownMessageStatus,
} from "./resources.js";
export { RemoteAppError } from "./remote-app.js";
