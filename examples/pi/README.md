# Pi harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs Pi Agent Core and provider integrations in a
  Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; provider credentials and
Pi configuration are supplied only to the harness VM.

The API exposes only `GET /health`, `POST /chat`, and `POST /steer`. Chat
requires `workspaceId`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceId`, `keepAliveSeconds`, and `prompt` to reuse it. Both
execution routes return an in-memory acceptance receipt with status `202`.

Both routes use the harness's single `run` entrypoint. The application input
identifies chat versus steer intent, and the retained Agent handles steer input
through Pi's native steering queue. FIFO processing means the steer request
waits for any earlier handler to settle.

`cantelop.json` targets an illustrative App with slug `pi`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
