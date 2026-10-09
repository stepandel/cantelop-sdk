import { sessionRuntime } from "./definition.js";
import type { AppSelector } from "@cantelop/sdk";
import { CantelopClient } from "@cantelop/sdk";

/** Configure once in the backend, then select Workspaces and Sessions from this App. */
export class AgentClient extends CantelopClient<typeof sessionRuntime> {
  constructor(options: (AppSelector | { id?: never; slug?: never }) & { profile?: string } = {}) {
    super({ ...options, sessionRuntime });
  }
}
