import { CantelopClient } from "@cantelop/sdk";
import { create } from "./agent.js";
import { codexAuth } from "./auth.js";
import type { SessionMessage, SessionEvent } from "./contracts.js";

export const app = new CantelopClient().app<SessionMessage, SessionEvent>({
  name: "codex",
  runtime: { create },
  auth: codexAuth,
  environment: {
    CODEX_PATH: { default: "/usr/local/bin/codex" },
    CODEX_MODEL: {},
  },
  dockerfile: "docker/Dockerfile",
});
