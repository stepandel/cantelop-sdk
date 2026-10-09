import { createApp, type AppConnection, type IntegrationSessionOptions, type WorkspaceSelector } from "@cantelop/sdk";
import type { SessionEvent, SessionMessage } from "./contracts.js";

/** Call from the application's backend with its App-bound connection. */
export function agentSession(
  connection: AppConnection,
  workspace: WorkspaceSelector,
  options: IntegrationSessionOptions,
) {
  return createApp<SessionMessage, SessionEvent>({ connection })
    .workspace(workspace)
    .session(options);
}
