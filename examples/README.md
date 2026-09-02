# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/session.ts  Linux-native Session behaviour
cantelop.json   Build and deployment manifest
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, and routes. Provider SDKs, credentials, and
incremental events remain confined to the native Session behaviour entrypoint.
Cantelop injects the current App into each API definition. Every API exposes
five routes: `GET /health`, `GET /events`, `POST /chat`, `POST /steer`, and
`POST /cancel`. Chat creates or reuses a Session from an optional ID; steer and
cancel require an existing Session ID. All message routes call the same asynchronous
`dispatch()` method and return an accepted message reference with HTTP status
`202`. Each example defines an explicit `SessionMessage` protocol with
`prompt`, `steer`, and `cancel` commands, plus a `SessionEvent` stream for text
deltas and completion. A steer received while idle starts a provider turn.
OpenAI keeps busy-time prompts in a per-Session FIFO because a text `run()`
cannot accept more input. Anthropic feeds prompts and prioritized steer commands
into its live `SDKUserMessage` stream. Pi applies active steer directly to its
Agent and keeps ordinary busy-time prompts in a Cantelop FIFO. All three
propagate cancel through the Session activity's `AbortSignal`. The Session
identity is propagated into the native Session runtime. The events route adapts
the App route to the platform event broker with `session.events(request)`.

Subscribe with SSE by passing the same Session coordinates used by the message
routes:

```ts
const query = new URLSearchParams({
  sessionId,
  workspaceId,
  keepAliveSeconds: String(keepAliveSeconds),
});
const events = new EventSource(`/events?${query}`);

events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "text_delta") render(event.delta);
  if (event.type === "done") events.close();
};
```

Choose the `sessionId` in the client, open the subscription, and then send the
first `POST /chat` with that ID. This ensures the live subscription exists
before the Session can publish its first delta.

`EventSource` automatically sends the last SSE event ID (`stream_id:sequence`)
when it reconnects. To resume a newly created subscription, append
`stream_id=<stream ID>&after=<last sequence>` to the query. The response envelope
includes the application event fields plus the trusted `stream_id`, `sequence`,
`session_id`, `message_id`, and `created_at` fields. A replaced or evicted stream
reports `event_stream_reset` rather than silently starting a new replay.

The same route also supports an output-only WebSocket:

```ts
const socket = new WebSocket(
  `${location.origin.replace(/^http/, "ws")}/events?${query}`,
  "cantelop.events.v1",
);

socket.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "text_delta") render(event.delta);
  if (event.type === "done") socket.close();
};
```

Send `prompt`, `steer`, and `cancel` through their HTTP routes, not through the
WebSocket. A WebSocket reconnect should include
`stream_id=<stream ID>&after=<last sequence>` because WebSockets do not provide
SSE's `Last-Event-ID` header. In a real application,
authenticate and authorize `/events` before calling `session.events(request)`;
the examples intentionally omit application-specific auth.

Each manifest targets an illustrative App slug. Create that App or change its
`app` value before running `cantelop deploy`; generated App IDs are never stored
in the example source.

Run all API and Session runtime type checks plus deployment bundle smoke checks from
the repository root:

```bash
pnpm check:examples
```
