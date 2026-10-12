# Multiple Apps in one codebase

[src/cantelop.ts](src/cantelop.ts) declares two Apps on one pure `CantelopClient`. Support emits a typed event; research returns a typed reply. They require no external provider and demonstrate the integration boundary rather than an LLM agent.

```ts
import { support, research } from "./src/cantelop.js";

await support.workspace({ slug: "customer-123" }).session().dispatch({ prompt: "Help" });
const result = await research.workspace({ slug: "customer-123" }).session().request({ topic: "Agents" });
```

The same Workspace slug addresses separate App namespaces. App names are explicit deployment identities; export names can change independently. The [compiler](../../docs/runtime-definitions.md) builds an isolated runtime/Edge pair per App and removes both implementations from the shared backend module. `cantelop.json` selects the definition module without repeating App names.

Use `buildAppArtifacts` for all Apps, or select `app: "support-agent"`/`"research-agent"` when building an individual artifact. Configure matching App-scoped credentials for both names in the client profile. Live deployment requires coordinated CLI/platform adoption of this unpublished SDK contract.
