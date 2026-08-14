# Anthropic harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs the Claude Agent SDK and its subprocess in a
  Linux-native VM.

Cantelop injects a remote Workspace execution provider when it creates the API and
supplies Anthropic credentials only to the harness VM.

```bash
pnpm install
pnpm check
```
