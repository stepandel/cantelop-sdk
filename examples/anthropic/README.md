# Anthropic harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs the Claude Agent SDK and its subprocess in a
  Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; Anthropic credentials are
supplied only to the harness VM.

The API exposes only `GET /health`, `POST /chat`, and `POST /steer`. Chat accepts
`keepAliveSeconds`, `prompt`, and an optional `sessionId`; it creates or reuses
that Session in the App's injected Workspace. Steer requires `sessionId`,
`keepAliveSeconds`, and `prompt` to reuse it. Both execution routes dispatch
asynchronously and return a durable receipt immediately with status `202`.

`cantelop.json` targets an illustrative App with slug `anthropic`. Change the
slug when deploying to a different App.

```bash
pnpm install
pnpm check
```
