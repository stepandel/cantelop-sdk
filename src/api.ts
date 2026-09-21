import type { CantelopApp } from "./resources.js";
import { createRouter, type Router } from "./router.js";

/** Customer variables and secrets supplied to an Edge API by Cantelop. */
export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export interface ApiContext<Input, Reply = unknown> {
  readonly app: CantelopApp<Input, Reply>;
  readonly env: ApiEnvironment;
  readonly router: Router;
}

type ApiRuntimeContext<Input, Reply> = Omit<ApiContext<Input, Reply>, "router">;

export interface ApiDefinition<Input, Reply = unknown> {
  create(
    context: ApiRuntimeContext<Input, Reply>,
  ): Router;
}

export type ApiFactory<Input, Reply = unknown> = (
  context: ApiContext<Input, Reply>,
) => void;

/** Defines an Edge API whose current App is injected by Cantelop. */
export function defineApi<Input, Reply = unknown>(
  factory: ApiFactory<Input, Reply>,
): ApiDefinition<Input, Reply> {
  return Object.freeze({
    create(context: ApiRuntimeContext<Input, Reply>): Router {
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
  RouteDescriptor,
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
  MessageExecution,
  Session,
  SessionIdentity,
  SessionOpenByIDConfig,
  SessionOpenBySlugConfig,
  SessionOpenConfig,
  SessionRequestOptions,
  SessionService,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceOpenConfig,
  WorkspaceService,
  UnknownMessageStatus,
} from "./resources.js";
export { RemoteAppError } from "./remote-app.js";
