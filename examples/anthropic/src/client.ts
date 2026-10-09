import { CantelopClient } from "@cantelop/sdk";
import type { SessionEvent, SessionMessage } from "./contracts.js";

/** Configure once in the backend, then select Workspaces and Sessions from this App. */
export class AgentClient extends CantelopClient<SessionMessage, SessionEvent> {}
