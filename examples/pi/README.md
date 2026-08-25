# Pi harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/session.ts` defines Session logic that runs Pi Agent Core and provider
  integrations in a Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; provider credentials and
Pi configuration are supplied only to the harness VM.

The API exposes `GET /health`, `POST /chat`, `POST /steer`, and `POST /cancel`.
Chat requires `workspaceId`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceId`, `keepAliveSeconds`, and `prompt` to reuse it. Cancel
requires the same Session fields without a prompt. All message routes return an
accepted message reference with HTTP status `202`.

The App has one Session logic with an explicit actor protocol. `prompt` and an
idle `steer` start a Pi run. A prompt received while busy enters a FIFO queue,
an active `steer` enters the Agent's native steering queue, and `cancel` aborts
the run and clears queued prompts. The actor owns one Pi `Agent`; no per-Session
registry is needed because the native runtime is already bound to one Session.
The prompt lives in the Session activity so the mailbox remains available for
new commands.

`cantelop.json` targets an illustrative App with slug `pi`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
