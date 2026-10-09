import type { App, CreateAppOptions, IntegrationSessionOptions, WorkspaceSelector } from "./integration.js";
import type { SessionRequestOptions, Workspace } from "./resources.js";
import { createRemoteApp, readWorkspace, requestJSON } from "./remote-app.js";
import { streamSessionEvents } from "./stream.js";

/**
 * Creates the backend integration facade over a trusted App-bound connection.
 * Public credential/endpoint discovery is provided by the platform, not this factory.
 */
export function createApp<Message = unknown, Event = unknown, Reply = unknown>(
  options: CreateAppOptions,
): App<Message, Event, Reply> {
  if (!options?.connection || typeof options.connection.fetch !== "function") {
    throw new TypeError("An App-bound connection is required");
  }
  const connection = options.connection;
  const runtimeFetch = (request: Request) => connection.fetch(request);
  return Object.freeze({
    workspace(input: WorkspaceSelector) {
      const selector = workspaceSelector(input);
      let pending: Promise<Workspace> | undefined;
      function resolve(): Promise<Workspace> {
        pending ??= requestJSON(runtimeFetch,
          selector.id === undefined
            ? "/__cantelop/v1/workspaces/open"
            : `/__cantelop/v1/workspaces/${encodeURIComponent(selector.id)}`,
          selector.id === undefined
            ? { method: "POST", body: { slug: selector.slug } }
            : { method: "GET" },
        ).then(value => {
          const workspace = readWorkspace(value, runtimeFetch, connection.localDatabaseOrigin);
          if (selector.id !== undefined ? workspace.id !== selector.id : workspace.slug !== selector.slug) {
            throw new TypeError("The connection returned a different Workspace");
          }
          return workspace;
        }).catch(error => { pending = undefined; throw error; });
        return pending;
      }
      const remote = createRemoteApp<Message, Reply>({
        fetch: runtimeFetch,
        resolveWorkspace: async config => config.workspaceId ?? (await resolve()).id,
      });
      return Object.freeze({
        selector,
        resolve,
        async database() { return (await resolve()).database(); },
        session(config: IntegrationSessionOptions) {
          const sessionOptions = {
            ...(config.id === undefined ? {} : { id: config.id }),
            keepAliveSeconds: config.keepAliveSeconds,
          };
          const session = selector.id === undefined
            ? remote.sessions.open({ ...sessionOptions, workspaceSlug: selector.slug })
            : remote.sessions.open({ ...sessionOptions, workspaceId: selector.id });
          return Object.freeze({
            id: session.id,
            workspace: selector,
            keepAliveSeconds: session.keepAliveSeconds,
            dispatch: (message: Message) => session.dispatch(message),
            request: (message: Message, requestOptions?: SessionRequestOptions) => session.request(message, requestOptions),
            stream: (streamOptions?: import("./integration.js").SessionStreamOptions) => streamSessionEvents<Event>(request => session.events(request), session.id, streamOptions),
            stop: () => session.stop(),
          });
        },
      });
    },
  });
}

function workspaceSelector(value: WorkspaceSelector): WorkspaceSelector {
  if (typeof value !== "object" || value === null || (value.id === undefined) === (value.slug === undefined)) {
    throw new TypeError("A Workspace requires exactly one ID or slug");
  }
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || !/^wsp_[0-9a-f]{32}$/.test(value.id)) throw new TypeError("Invalid Cantelop Workspace ID");
    return Object.freeze({ id: value.id });
  }
  if (typeof value.slug !== "string" || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.slug)) {
    throw new TypeError("Invalid Cantelop Workspace slug");
  }
  return Object.freeze({ slug: value.slug });
}
