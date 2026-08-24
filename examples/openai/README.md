# OpenAI harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs in a Linux-native VM with the OpenAI Agents SDK.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; `OPENAI_API_KEY` is
supplied only to the harness VM. The manifest requires that secret and declares
`gpt-4.1-mini` as the non-secret local default for `OPENAI_MODEL`.

Both execution routes accept `workspaceId`, `keepAliveSeconds`, `prompt`, and
an optional `sessionId`. `POST /execute` waits for output; `POST /dispatch`
returns a durable receipt immediately with status `202`. The first operation
atomically creates the Session when its ID does not exist.

`cantelop.json` targets an illustrative App with slug `openai`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
