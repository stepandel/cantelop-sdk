import type { D1Database } from "@cloudflare/workers-types";
export type { D1Database, D1PreparedStatement, D1Result, D1Meta, D1ExecResult, D1DatabaseSession, D1SessionBookmark, D1SessionConstraint } from "@cloudflare/workers-types";

import type { CantelopApp } from "./resources.js";
import { createRouter, type Router } from "./router.js";

/** Customer variables and secrets supplied to an Edge API by Cantelop. */
export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

export interface ApiContext<Input, Reply = unknown> {
  readonly app: CantelopApp<Input, Reply>;
  readonly env: ApiEnvironment;
  /** Native App database, when enabled. Create statements and sessions inside handlers. */
  readonly db?: D1Database;
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
      factory(Object.freeze({ app: context.app, env: context.env, ...(context.db === undefined ? {} : { db: context.db }), router }));
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
