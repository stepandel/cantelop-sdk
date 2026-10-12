import { create } from "./agent.js";
import { opencodeAuth } from "./auth.js";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "opencode",
  runtime: { create },
  auth: opencodeAuth,
  environment: {
    OPENCODE_PATH: { default: "/usr/local/bin/opencode" },
    OPENCODE_MODEL: {},
    OPENCODE_LOGIN_PROVIDER: { default: "opencode" },
  },
  dockerfile: "docker/Dockerfile",
});
