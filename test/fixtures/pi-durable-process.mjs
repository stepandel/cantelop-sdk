// The parent kills this process after Pi commits a tool's execution intent.
import { createClient } from "@libsql/client";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openPiDurableHarness } from "../../dist/pi-durable.js";
const database = createClient({ url: process.argv[2] });
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
]);
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "effects",
    tools: [
      defineTool({
        name: "effect",
        description: "Crash fixture",
        parameters: Type.Object({}),
        replay: process.argv[3],
        execute: async () => {
          process.send({ type: "tool-started" });
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        },
      }),
    ],
  }),
);
const harness = await openPiDurableHarness(
  { database, sessionId: "agent", harness: { models, registry } },
  ctx,
);
const model = faux.getModel();
const root = await harness.root(ctx, {
  agent: { model: { provider: model.provider, modelId: model.id } },
});
await root.submit(
  { type: "input", content: "run effect", requestId: "crash-intake" },
  ctx,
);
harness.resume();
