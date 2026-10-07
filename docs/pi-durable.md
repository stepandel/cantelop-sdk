# Pi Durable

`@cantelop/sdk/pi-durable` runs the upstream Pi Durable harness inside a Cantelop
Session, backed by the existing Workspace database. It needs no changes to Pi,
no extra database per Session, and no SQLite file on the Workspace filesystem.

Install the optional, exact-version peers (Pi Durable's API is experimental):

```sh
pnpm add @cantelop/sdk @earendil-works/pi-durable@1.0.4 @earendil-works/pi-ai@1.0.4 @earendil-works/chord@1.0.4
```

Existing SDK entry points do not load Pi. The Session integration requires Node
22.19+ or a compatible Bun runtime; the browser event decoder has a separate,
portable import. See [the runnable example](../examples/pi-durable/README.md).

## Session behaviour

```ts
import { definePiDurableSession } from "@cantelop/sdk/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry } from "@earendil-works/pi-durable";

const models = createModels();
models.setProvider(openaiProvider());
export default definePiDurableSession({
  harness: { models, registry: createRegistry() },
  agent: { model: { provider: "openai", modelId: "gpt-6-sol" } },
});
```

`harness` can also be an async factory receiving the Session identity, environment
and database access. `agent` initializes the root only when it is first created;
persisted configuration survives replacement. `onOpen(harness, context)` gives
application code the complete upstream Harness for documents, extensions,
configuration, conversations, forks and custom tasks. Keep initialization short;
intake waits for it. Install extension/task definitions in the registry before
opening; it is application code and is reinstalled after every process restart.

Each fresh activation opens the same logical store and resumes Pi's scheduler,
including ordinary activation after parking. Recovery is idempotent and does
not turn the old transport message into a new model run.

The protocol is:

| Message | Behaviour / requested reply |
| --- | --- |
| `{ type: "input", content, whenBusy? }` | Durably submit input; reply contains `conversationId` and `submissionId`. `whenBusy` is `steer`, `followUp` (default), or `reject`. |
| `{ type: "write", entry }` | Durably append a passive entry with the same admission reply. |
| `{ type: "abortSubmission", submissionId }` | Request withdrawal of that exact queued submission; already placed/settled inputs are unchanged. Reply acknowledges the request, not cancellation of running work. |
| `{ type: "abortTask", taskId }` | Durably request cancellation of that exact task and its owned work. Reply acknowledges the request; task state reports completion. |
| `{ type: "snapshot", conversationId? }` | Emit a committed snapshot; reply contains its conversation ID. |
| `{ type: "resume" }` | Enable scheduling and reconcile activity tracking. |

Input/write/snapshot messages may name `conversationId`; omission selects the
root. Cantelop's immutable `message.id` overrides a payload `requestId` as Pi's
conversation-scoped deduplication key. Successful intake means **committed
admission**, not a completed agent job. Task cancellation targets a persisted ID,
so redelivery cannot cancel a subsequently created task. Cancelling an intake
cannot retract an already acknowledged Pi submission.

The adapter tracks every live task in the Harness's task graph: foreground,
background, child, waiting, sleeping and blocked work. It renews the managed
activity deadline until all tasks drain. The default activity timeout is 30
minutes and is renewed every third of that period; `activityTimeoutMs` accepts
3ms–24h. Long delays/blocked tasks keep compute active. This integration does not
park sleeping jobs and schedule future compute wakes. Failure/timeout of an
individual intake is separate from Pi task execution.

Platform activity cancellation and Session stop close the harness, preserving
unfinished checkpoints. A later activation resumes them. Use `abortTask` to
persist an application cancellation. Pi controls safe/unsafe tool replay;
external side effects still require application idempotency. Unexpected runtime
loss recovers through Cantelop's existing activity/owner recovery contract.

## Storage and ownership

`openPiDurableStorage(database, sessionId, context?)` implements Pi's entire
`Storage` interface. `openPiDurableHarness({ database, sessionId, harness },
context?)` returns the full upstream Harness. These lower-level APIs are useful
for a custom behaviour; their caller owns scheduling, activity accounting,
observation and close. Opening alone does not run tasks; call `resume()`.

Two application-owned tables are installed atomically on first use:
`cantelop_pi_stores` and `cantelop_pi_commits`. The commit log is indexed by
`(session_id, seq)`, with independent record IDs, commit sequences and writer
tokens per Session. Session IDs are bound parameters, never SQL identifiers.
The SDK's renewable database client keeps each SQL transaction on its original
connection. Closing a Pi store/harness leaves the caller's Workspace client open.

Before each SQL commit, Pi's public `MemoryStorage.prepareCommit()` validates
and detaches the batch. One database transaction advances the fenced sequence
and persists the batch; only successful commit permits adopting and publishing
it. Reopen replays the contiguous log into the reference read projection. This
preserves Pi's fork/history/document semantics rather than implementing another
query model. The backend passes Pi 1.0.4's complete storage conformance suite.

A new open fences its predecessor's database writes. It is an ownership handoff,
not a read-only API: do not open another Harness to inspect a running Session.
Request its snapshot instead. Cantelop must still stop/fence the old compute
owner before starting replacement execution; a database token cannot stop an
old process's external tool side effects.

Transport failures after a write/commit can be ambiguous. The store fails closed
and requires reopen, which resolves the persisted log; it never retries SQL
statements or commits. Only an explicit `SQLITE_BUSY` rejection while beginning
a transaction is retried for up to five seconds, before any statement is issued.
Unrelated transactions on the same database object are serialized.

The initial backend retains an append-only log and an in-memory read projection.
Startup work and memory grow with retained history, and this release supplies no
log compactor. It does not promise indexed remote queries or constant-time reopen
for very large histories. Pi's own context compaction reduces model context; it
does not prune this persistence history. Durability follows the managed database's
committed-write guarantees. Local SQL tests are not a live Turso/host qualification.

## Observation

Root conversation changes and the entire task graph are streamed from Pi's
committed watches. A stream starts with a `snapshot` containing the conversation
view and `tasks`, then emits conversation `change` operations and complete `tasks`
updates. A root snapshot request during an activity uses that same stream.
Other conversations can be snapshotted explicitly; custom live subscriptions can
be built with the full Harness API.

Snapshots can exceed Cantelop's output size limit. Updates are encoded as base64
UTF-8 JSON, in 24 KiB byte chunks with stream ID, sequence, part and total parts.
Chunks of a live update are emitted serially. Route frames by their
`conversationId`, then decode one conversation stream:

```ts
import { createPiDurableEventDecoder } from "@cantelop/sdk/pi-durable/events";
const decoder = createPiDurableEventDecoder();
const update = decoder.push(event); // undefined until the complete update arrives
// snapshot: replace the view/tasks; change: apply Chord ops; tasks: replace graph
```

Use a separate decoder per conversation. The default decoded update limit is
32 MiB and can be changed with `maxBytes`. A missing/reordered frame throws and
resets the decoder; request a new snapshot and stop applying stale deltas. On
transport reconnect/reset, request a snapshot. Cantelop's transport cursor is
not a durable transcript cursor. Pi's watches coalesce slow observers into fresh
state, and output delivery never authorizes a database commit or replaces it. Each
activity drains output and ends with a fresh committed snapshot, preserving the
final answer even when stopping a watch discards pending frames.

## Verification

Run `pnpm test`, `pnpm test:pi-durable:bun`, `pnpm check:examples`, and
`pnpm check:package`. Pi coverage includes
all upstream storage conformance cases, Session isolation, stale writers,
rollback and ambiguous-commit recovery, activation/recovery, background task
activity renewal, intake while busy, stable-ID deduplication, steering/follow-ups,
safe/unsafe tools, and chunked snapshot reconstruction.
