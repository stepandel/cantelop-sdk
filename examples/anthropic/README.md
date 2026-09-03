# Anthropic Session runtime example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/session.ts` defines Session behaviour that runs the Claude Agent SDK and its
  subprocess in a Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; Anthropic credentials are
supplied only to the Session runtime. The manifest requires `ANTHROPIC_API_KEY`
as a production secret.

The API exposes `GET /health`, `GET /events`, `POST /chat`, `POST /steer`, and
`POST /cancel`.
Chat requires `workspaceSlug`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceSlug`, `keepAliveSeconds`, and `prompt` to reuse it. Cancel
requires the same Session fields without a prompt. All message routes return an
accepted message reference with HTTP status `202`.
`GET /events` accepts `sessionId`, `workspaceSlug`, and `keepAliveSeconds` as
query parameters and streams that Session's events over SSE or the
`cantelop.events.v1` WebSocket subprotocol. See the [shared example
guide](../README.md) for client and reconnect examples.

The App has one Session behaviour with an explicit actor protocol. `prompt` and an
idle `steer` start one streaming-input Claude query. While it is active, actor
messages are written directly to the SDK's `AsyncIterable<SDKUserMessage>`:
ordinary prompts use native `later` priority and steer commands use `now`.
`cancel` closes that input stream and aborts the query. The actor retains
Claude's conversation ID for reactivation; no per-Session registry or duplicate
application queue is needed. The live query remains the Session activity so the
mailbox can continue feeding it commands.

`cantelop.json` targets an illustrative App with slug `anthropic`. Change the
slug when deploying to a different App.

```bash
pnpm install
pnpm check
```
