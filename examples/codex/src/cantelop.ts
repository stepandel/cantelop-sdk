import { CantelopClient } from "@cantelop/sdk";
import { create } from "./agent.ts";
import { codexAuth } from "./auth.ts";
import { CODEX_BINARY } from "./environment.ts";
import type { SessionMessage, SessionEvent } from "./contracts.ts";

export const app = new CantelopClient().app<SessionMessage, SessionEvent>({
  name: "codex",
  runtime: { create },
  auth: codexAuth,
  environment: {
    CODEX_PATH: { default: CODEX_BINARY },
    CODEX_MODEL: {},
  },
  dockerfile: "docker/Dockerfile",
});
