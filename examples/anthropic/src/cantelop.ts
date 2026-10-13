import { createClaudeHarness, claudeAuth, claudeDockerfile } from "@cantelop/sdk/harnesses/claude";
import { CantelopClient } from "@cantelop/sdk";
import type { ClaudeMessage, ClaudeEvent } from "@cantelop/sdk/harnesses/claude";

const cantelop = new CantelopClient();

export const app = cantelop.app<ClaudeMessage, ClaudeEvent>({
  name: "anthropic",
  runtime: { create: createClaudeHarness },
  auth: claudeAuth,
  environment: {
    CLAUDE_PATH: { default: "/usr/local/bin/claude" },
    CLAUDE_MODEL: {},
  },
  dockerfile: claudeDockerfile,
});
