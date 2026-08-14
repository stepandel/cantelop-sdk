# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/harness.ts  Linux-native agent runtime
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, and routes. Provider SDKs, credentials, and
incremental events remain confined to the harness entrypoint. Cantelop injects
the current App into each API definition. The examples create Workspaces and
Sessions explicitly, then perform every execution through a reusable Session;
direct client streaming is configured at the VM.

Run all API and harness type checks from the repository root:

```bash
pnpm check:examples
```
