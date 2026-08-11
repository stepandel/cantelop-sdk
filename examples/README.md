# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/harness.ts  Linux-native agent runtime
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, routes, and SSE response helper. Provider
SDKs and credentials remain confined to the harness entrypoint. Cantelop creates
each API definition with a remote execution environment connected to its
corresponding harness VM.

Run all API and harness type checks from the repository root:

```bash
pnpm check:examples
```
