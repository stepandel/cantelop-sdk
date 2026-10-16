import { CantelopClient } from "@cantelop/sdk";
import { receive } from "./agent.ts";
import { homepage } from "./homepage.ts";
import { handleGitHub } from "./github.ts";
import type { IssueMessage } from "./contracts.ts";

const cantelop = new CantelopClient();

export const app = cantelop.app<IssueMessage>({
  name: "github-agent",
  runtime: { receive },
  homepage,
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
