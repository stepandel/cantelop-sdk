import { CantelopClient } from "@cantelop/sdk";
import { receive } from "./agent.js";
import { handleGitHub } from "./github.js";
import type { IssueMessage } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<IssueMessage>({
  name: "github-agent",
  runtime: { receive },
  webhooks: {
    "/webhooks/github": { method: "POST", handle: handleGitHub },
  },
  environment: {
    GITHUB_WEBHOOK_SECRET: { secret: true, required: true },
    GITHUB_TOKEN: { secret: true, required: true },
    OPENAI_API_KEY: { secret: true, required: true },
    OPENAI_MODEL: { default: "gpt-5-mini" },
  },
});
