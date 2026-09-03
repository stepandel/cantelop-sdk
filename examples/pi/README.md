# Pi Session runtime example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/session.ts` defines Session behaviour that runs Pi Agent Core and provider
  integrations in a Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; provider credentials and
Pi configuration are supplied only to the Session runtime. The manifest defaults
to Anthropic's `claude-sonnet-5`, requires `ANTHROPIC_API_KEY`, and exposes
`PI_PROVIDER` and `PI_MODEL` as local defaults. If you select another provider,
replace the credential declaration with the secret that provider requires.

The API exposes `GET /health`, `GET /events`, `POST /chat`, `POST /steer`, and
`POST /cancel`.
Chat requires `workspaceId`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceId`, `keepAliveSeconds`, and `prompt` to reuse it. Cancel
requires the same Session fields without a prompt. All message routes return an
accepted message reference with HTTP status `202`.
`GET /events` accepts `sessionId`, `workspaceId`, and `keepAliveSeconds` as
query parameters and streams that Session's events over SSE or the
`cantelop.events.v1` WebSocket subprotocol. See the [shared example
guide](../README.md) for client and reconnect examples.

The App has one Session behaviour with an explicit actor protocol. `prompt` and an
idle `steer` start a Pi run. A prompt received while busy enters a FIFO queue,
an active `steer` enters the Agent's native steering queue, and `cancel` aborts
the run and clears both Cantelop and native Pi queues. The actor owns one Pi `Agent`; no per-Session
registry is needed because the native runtime is already bound to one Session.
The prompt lives in the Session activity so the mailbox remains available for
new commands.

`cantelop.json` targets an illustrative App with slug `pi`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
