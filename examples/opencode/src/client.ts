import type { SessionMessage, SessionEvent } from "./contracts.js";
import type { AppSelector } from "@cantelop/sdk";
import { CantelopClient } from "@cantelop/sdk";

/** Configure once in the backend, then select Workspaces and Sessions from this App. */
export class AgentClient extends CantelopClient<SessionMessage, SessionEvent> {
  constructor(options: (AppSelector | { id?: never; slug?: never }) & { profile?: string } = {}) {
    super({ ...options, sessionRuntime: { id: "opencode.v1", receive: async context => (await import("./session.js")).receive(context) } });
  }
}

export const cantelop = new AgentClient();
export default cantelop;
