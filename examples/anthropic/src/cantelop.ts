import { createClaudeRuntime, claudeAuth, claudeDockerfile } from "@cantelop/sdk/harnesses/claude";
import { CantelopClient } from "@cantelop/sdk";
import type { ClaudeSessionCommand, ClaudeSessionEvent, ClaudeSessionReply, ClaudeSessionView } from "@cantelop/sdk/harnesses/claude";

const cantelop = new CantelopClient();

export const app = cantelop.app<ClaudeSessionCommand, ClaudeSessionEvent, ClaudeSessionReply, ClaudeSessionView>({
  name: "anthropic",
  runtime: createClaudeRuntime(),
  auth: claudeAuth,
  environment: {
    CLAUDE_PATH: { default: "/usr/local/bin/claude" },
    CLAUDE_MODEL: {},
  },
  dockerfile: claudeDockerfile,
});
