import type { SessionControlOptions, SessionView, WorkspaceSelector } from "./integration.js";
import type { MessageRef } from "./resources.js";
import { RemoteAppError, readMessageStatus, requestJSON } from "./remote-app.js";

/** SDK foundation contract. Platform rollout is required for these routes. */
export const CANTELOP_INTEGRATION_PROTOCOL_VERSION = 1;
const PREFIX = "/__cantelop/integration/v1";

export function integrationSessionPath(id: string, workspace: WorkspaceSelector, suffix = ""): string {
  const query = new URLSearchParams(workspace.id === undefined ? { workspace_slug: workspace.slug } : { workspace_id: workspace.id });
  return `${PREFIX}/sessions/${encodeURIComponent(id)}${suffix}?${query}`;
}

export async function viewSession(
  fetch: (request: Request) => Promise<Response>,
  id: string,
  workspace: WorkspaceSelector,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SessionView> {
  options.signal?.throwIfAborted();
  const value = await requestJSON(fetch, integrationSessionPath(id, workspace), {
    method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!isRecord(value) || value.protocol_version !== CANTELOP_INTEGRATION_PROTOCOL_VERSION || value.id !== id ||
      !["unmaterialized", "active", "idle"].includes(String(value.state)) ||
      typeof value.observed_at !== "string" || !isRecord(value.capabilities) ||
      typeof value.capabilities.steer !== "boolean" || typeof value.capabilities.abort !== "boolean") throw invalid("invalid_session_view");
  const observedAt = new Date(value.observed_at);
  if (!Number.isFinite(observedAt.valueOf())) throw invalid("invalid_session_view");
  if (value.workspace_id !== undefined && (typeof value.workspace_id !== "string" || !/^wsp_[0-9a-f]{32}$/.test(value.workspace_id))) throw invalid("invalid_session_view");
  if (value.state !== "unmaterialized" && value.workspace_id === undefined) throw invalid("invalid_session_view");
  if (workspace.id !== undefined && value.workspace_id !== undefined && workspace.id !== value.workspace_id) throw invalid("workspace_conflict");
  return Object.freeze({
    id, state: value.state as SessionView["state"], observedAt,
    ...(value.workspace_id === undefined ? {} : { workspaceId: value.workspace_id as string }),
    capabilities: Object.freeze({ steer: value.capabilities.steer, abort: value.capabilities.abort }),
  });
}

export async function controlSession(
  fetch: (request: Request) => Promise<Response>,
  sessionId: string,
  workspace: WorkspaceSelector,
  control: { readonly type: "steer"; readonly input: unknown } | { readonly type: "abort" },
  options: SessionControlOptions = {},
): Promise<MessageRef> {
  const id = options.id ?? `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  if (typeof id !== "string" || !/^msg_[0-9a-f]{32}$/.test(id)) throw new TypeError("Invalid Cantelop Message ID");
  if (control.type === "steer" && JSON.stringify(control.input) === undefined) throw new TypeError("Steering input must be JSON-compatible");
  options.signal?.throwIfAborted();
  let value: unknown;
  try {
    value = await requestJSON(fetch, integrationSessionPath(sessionId, workspace, "/controls"), {
      method: "POST", body: { protocol_version: CANTELOP_INTEGRATION_PROTOCOL_VERSION, id, ...control },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof RemoteAppError) throw new RemoteAppError(error.code, error.status, id, { cause: error });
    throw new RemoteAppError("control_outcome_unknown", 0, id, { cause: error });
  }
  if (!isRecord(value) || value.protocol_version !== CANTELOP_INTEGRATION_PROTOCOL_VERSION || value.id !== id || value.status !== "accepted" || typeof value.accepted_at !== "string") {
    throw new RemoteAppError("invalid_control_response", 0, id);
  }
  const acceptedAt = new Date(value.accepted_at);
  if (!Number.isFinite(acceptedAt.valueOf())) throw new RemoteAppError("invalid_control_response", 0, id);
  return Object.freeze({
    id, state: "accepted", acceptedAt,
    async status() {
      const value = await requestJSON(fetch, integrationSessionPath(sessionId, workspace, `/controls/${id}`), { method: "GET" });
      if (!isRecord(value) || value.protocol_version !== CANTELOP_INTEGRATION_PROTOCOL_VERSION) throw invalid("invalid_control_status_response");
      return readMessageStatus(value, id);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(code: string): RemoteAppError { return new RemoteAppError(code, 0); }
