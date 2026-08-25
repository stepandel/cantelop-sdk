# OpenAI harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/session.ts` defines Session logic that runs in a Linux-native VM with
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
in-memory acceptance receipt with status `202`.

The message routes target the App's single Session logic. Its `receive`
entrypoint handles each message. The
application message identifies chat, steer, or cancel intent; this example adds
either prompt as another
turn in the Session's shared OpenAI `MemorySession`. The active run is a
runtime-managed Session activity: steer queues the next turn without blocking
the mailbox, while cancel aborts the run through its activity signal and clears
queued prompts.

`cantelop.json` targets an illustrative App with slug `openai`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
