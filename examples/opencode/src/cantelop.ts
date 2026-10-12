import { create } from "./agent.ts";
import { opencodeAuth } from "./auth.ts";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.ts";

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
