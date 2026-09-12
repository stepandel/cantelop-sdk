import type { D1Database } from "@cloudflare/workers-types";
export type { D1Database, D1PreparedStatement, D1Result, D1Meta, D1ExecResult, D1DatabaseSession, D1SessionBookmark, D1SessionConstraint } from "@cloudflare/workers-types";

import type { CantelopApp } from "./resources.js";
import { createRouter, type Router } from "./router.js";

/** Customer variables and secrets supplied to an Edge API by Cantelop. */
export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export interface ApiContext<Input> {
  readonly app: CantelopApp<Input>;
  readonly env: ApiEnvironment;
  /** Native App database, when enabled. Create statements and sessions inside handlers. */
  readonly db?: D1Database;
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
      factory(Object.freeze({ app: context.app, env: context.env, ...(context.db === undefined ? {} : { db: context.db }), router }));
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
  MessageExecution,
  Session,
  SessionIdentity,
  SessionOpenByIDConfig,
  SessionOpenBySlugConfig,
  SessionOpenConfig,
  SessionService,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceOpenConfig,
  WorkspaceService,
  UnknownMessageStatus,
} from "./resources.js";
export { RemoteAppError } from "./remote-app.js";
