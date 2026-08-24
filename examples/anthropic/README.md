# Anthropic harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs the Claude Agent SDK and its subprocess in a
  Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; Anthropic credentials are
supplied only to the harness VM.

`POST /execute` waits for a reusable Session's output. `POST /dispatch` accepts
`workspaceId`, `sessionKey`, `keepAliveSeconds`, and `prompt`, then returns the
durable execution receipt immediately with status `202`.

`cantelop.json` targets an illustrative App with slug `anthropic`. Change the
slug when deploying to a different App.

```bash
pnpm install
pnpm check
```
