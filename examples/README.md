# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/harness.ts  Linux-native agent runtime
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, and routes. Provider SDKs, credentials, and
incremental events remain confined to the harness entrypoint. Cantelop creates
each API definition with a remote Workspace execution provider connected to its
corresponding harness VM; direct client streaming is configured at the VM.

Run all API and harness type checks from the repository root:

```bash
pnpm check:examples
```
