# Anthropic harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs the Claude Agent SDK and its subprocess in a
  Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; Anthropic credentials are
supplied only to the harness VM.

```bash
pnpm install
pnpm check
```
