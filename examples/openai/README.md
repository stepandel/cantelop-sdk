# OpenAI harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/session.ts` defines Session behaviour that runs in a Linux-native VM with
  the OpenAI Agents SDK.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; `OPENAI_API_KEY` is
supplied only to the harness VM. The manifest requires that secret and declares
`gpt-4.1-mini` as the non-secret local default for `OPENAI_MODEL`.

The API exposes `GET /health`, `POST /chat`, `POST /steer`, and `POST /cancel`.
Chat requires `workspaceId`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceId`, `keepAliveSeconds`, and `prompt` to reuse it. Cancel
requires the same Session fields without a prompt. All message routes return an
accepted message reference with HTTP status `202`.

The App has one Session behaviour with an explicit actor protocol. `prompt` and an
idle `steer` start an OpenAI run. Prompts and steer commands received while a
run is active enter a FIFO queue, and `cancel` aborts the run and clears that
queue. The actor owns one OpenAI `Agent` and `MemorySession`; no per-Session
registry is needed because the native runtime is already bound to one Session.
The run lives in the Session activity so the mailbox remains available for new
commands.

`cantelop.json` targets an illustrative App with slug `openai`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
