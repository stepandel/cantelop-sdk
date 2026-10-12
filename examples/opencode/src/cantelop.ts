import { create } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "opencode",
  runtime: { create, steering: "interrupt" },
  environment: {
    OPENCODE_PATH: { default: "/usr/local/bin/opencode" },
    OPENCODE_MODEL: {},
  },
  dockerfile: "docker/Dockerfile",
});
