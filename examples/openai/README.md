# OpenAI harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs in a Linux-native VM with the OpenAI Agents SDK.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; `OPENAI_API_KEY` is
supplied only to the harness VM. The manifest requires that secret and declares
`gpt-4.1-mini` as the non-secret local default for `OPENAI_MODEL`.

The API exposes only `GET /health`, `POST /chat`, and `POST /steer`. Chat
requires `workspaceId`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceId`, `keepAliveSeconds`, and `prompt` to reuse it. Both
execution routes return a durable receipt immediately with status `202`.

Both routes use the harness's single `run` entrypoint. The application input
identifies chat versus steer intent; this example adds either prompt as another
turn in the Session's shared OpenAI `MemorySession`.

`cantelop.json` targets an illustrative App with slug `openai`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
