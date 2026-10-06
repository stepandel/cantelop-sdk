# Pi Durable example

This App runs Pi Durable with coding tools in a Cantelop Session and persists its
complete state in that Workspace's managed database. Multiple Sessions share
the database and keep separate logical stores and working directories.

```sh
pnpm install
pnpm check
cantelop dev
```

Set `OPENAI_API_KEY` in your environment or local `.env` (see `.env.example`).
`PI_MODEL` defaults to `gpt-6-sol`. Change the App slug in `cantelop.json` for
deployment. Provider credentials stay in the Session runtime; the API only
imports Pi message/reply types, which disappear from the Edge bundle.

`POST /message` takes a Workspace slug, Session ID, Pi message and optional
stable request ID. For example:

```json
{
  "workspaceSlug": "default",
  "sessionId": "coding",
  "requestId": "hello-1",
  "message": { "type": "input", "content": "Inspect this project" }
}
```

The response contains a committed Pi submission receipt. To steer the active
run, submit another input with `whenBusy: "steer"`; to queue a follow-up use
`whenBusy: "followUp"`. `abortSubmission` withdraws an exact queued input and
`abortTask` cancels an exact persisted task ID found in the streamed task graph.

`GET /events?workspaceSlug=default&sessionId=coding` streams Cantelop events.
After connecting/reconnecting, send `{ "type": "snapshot" }` through `/message`.
Decode Pi chunks using `createPiDurableEventDecoder` from
`@cantelop/sdk/pi-durable/events`. Snapshots replace the conversation view/task
graph; change frames carry Chord operations; task frames replace the graph.
The stream is delivery, while the database remains the conversation record.

See [the package guide](../../docs/pi-durable.md) for ownership, cancellation,
storage growth, lifecycle and custom Harness APIs.
