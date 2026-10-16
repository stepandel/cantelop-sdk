import { CantelopClient } from "@cantelop/sdk";
import {
  createCodexRuntime,
  createCodexAuth,
  codexDockerfile,
} from "@cantelop/sdk/harnesses/codex";
import type {
  CodexSessionCommand,
  CodexSessionEvent,
  CodexSessionReply,
} from "@cantelop/sdk/harnesses/codex/protocol";

export const app = new CantelopClient().app<
  CodexSessionCommand,
  CodexSessionEvent,
  CodexSessionReply
>({
  name: "durable-codex",
  runtime: createCodexRuntime({
    workspace: "/workspace",
    sandbox: "workspace-write",
    approvalPolicy: "never",
  }),
  auth: createCodexAuth({ workspace: "/workspace" }),
  dockerfile: codexDockerfile,
});
