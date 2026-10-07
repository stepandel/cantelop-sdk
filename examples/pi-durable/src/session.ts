import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { definePiDurableSession } from "@cantelop/sdk/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, configure } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export default definePiDurableSession({
  async harness({ session, env }) {
    const models = createModels();
    models.setProvider(openaiProvider());
    const registry = createRegistry();
    registry.install(CodingTools);
    // Workspace files can be shared by Sessions; this example gives each its own cwd.
    const cwd = join("/workspace", "pi", encodeURIComponent(session.id));
    await mkdir(cwd, { recursive: true });
    const modelId = env.PI_MODEL ?? "gpt-6-sol";
    if (!models.getModel("openai", modelId))
      throw new Error(`Unknown OpenAI model: ${modelId}`);
    return {
      models,
      registry,
      env: ({ cwd: selected }) =>
        new NodeExecutionEnv({ cwd: selected ?? cwd }),
      // Initialize the model on each NEW conversation; persisted agent choices survive reopen.
      conversationCreated: async (tx, conversation) => {
        await configure(tx, conversation.id, {
          model: { provider: "openai", modelId },
          cwd,
        });
      },
      settings: { progress: { partialIntervalMs: 500, outputIntervalMs: 500 } },
    };
  },
  onError(error) {
    console.error("Pi Durable execution failed", error);
  },
});
