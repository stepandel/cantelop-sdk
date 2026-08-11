# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/harness.ts  Linux-native agent runtime
```

All three APIs reuse `shared/prompt-api.ts`, so provider SDKs and credentials
remain confined to their harness entrypoints. Cantelop creates an API definition
with a remote execution environment connected to the corresponding harness VM.

Run all API and harness type checks from the repository root:

```bash
pnpm check:examples
```
