import { createApp, type CreateAppOptions } from "@cantelop/sdk";
import type { SessionEvent, SessionMessage } from "./contracts.js";

/** Configure once in the backend, then select Workspaces and Sessions from this App. */
export function createAgentApp(options: CreateAppOptions) {
  return createApp<SessionMessage, SessionEvent>(options);
}
