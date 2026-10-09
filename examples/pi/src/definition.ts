import { defineSessionRuntime } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

export const sessionRuntime = defineSessionRuntime<SessionMessage, SessionEvent>({
  id: "pi.v1", entrypoint: "./session.ts",
});
export default sessionRuntime;
