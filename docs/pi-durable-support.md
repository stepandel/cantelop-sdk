# Native Pi Durable support assessment

Assessed against Pi Durable **v1.0.0** on 2026-10-02. Pi Durable is an
experimental package whose API can change between releases. This note concerns
`@earendil-works/pi-durable`, not an upgrade of the existing Pi Agent Core
example.

## Decision

Cantelop can host Pi Durable, but the current SDK and documented platform
contract cannot yet promise **native durable execution**. Shipping an example
that merely imports the package would leave its most important guarantees
unmet. Native support needs a storage adapter with verified commit durability,
an activation and wake contract for pending Pi tasks, and observation that
starts from Pi's committed state.

The existing [Pi example](../examples/pi/src/session.ts) owns a process-local
`Agent` and prompt queue. Its output is forwarded through Cantelop's transient
event stream. Neither queue nor transcript nor running tool intent is persisted
for recovery. Updating its Pi dependencies to 1.0 does not change that model.

## Pi's contract and Cantelop's current fit

| Pi Durable v1.0 principle | Current Cantelop contract | Needed integration |
| --- | --- | --- |
| Transcript, inbox, task checkpoints, and app documents are committed atomically before publication | `/workspace` survives Sandbox replacement, but SDK state, the mailbox, managed activity, and event replay are in memory | Pi owns these records in one verified transactional store; application messages are translated into Pi submissions with stable request IDs |
| Pending tasks resume from checkpoints after a process restart | `onRecover` runs only for unexpected Sandbox loss with outstanding work, and only when opted in | Open the same Pi store and call `harness.resume()` on **every** activation, before admitting new commands; establish that the old process has stopped before the replacement opens that store |
| Unsafe interrupted tools are reported as interrupted; only `replay: "safe"` tools rerun | Cantelop's generic recovery is at least once and supplies an interrupted message ID | Leave tool replay to Pi; do not replay the HTTP/message handler's side effects or rebuild a run from the prompt |
| Follow-ups and steers live in Pi's committed inbox | The current example keeps follow-ups in a process-local array and uses Agent Core steering | Call Pi `submit({ type: "input", ..., whenBusy })`; preserve the caller's mode and request ID instead of maintaining a second queue |
| Child and background work have explicit ownership | Runtime quiescence checks only the in-memory mailbox and one managed activity; each activity timeout request is capped at 24 hours and can be extended | Give the platform a Pi-aware busy/wake signal. Pending owned work must survive release and be resumed without needing a new user message |
| Pi views and agent events derive from committed state | `output.send()` publishes application output to `session.events()`, a bounded streaming transport whose replacement reports reset | Initialize clients from Pi's current view or `watchEvents()` snapshot, then stream updates. Treat Cantelop events as delivery, never as the conversation record |
| One process owns a Pi store at a time | Each active Session has one runtime process, and a Workspace can be shared by Sessions | Use a separate store directory per Session so different Sessions may write concurrently; verify that replacement processes for the **same** Session never overlap on that directory |

## Storage choice

Do **not** put Pi's bundled Node SQLite database at `/workspace`: Pi's adapter
uses WAL, and SQLite documents that WAL does not work on a network filesystem.
The current Workspace is NFS and can be mounted by multiple Sandboxes. Putting
SQLite on ephemeral local disk also loses the commit-before-publication guarantee
when that Sandbox is replaced.

Pi's Node JSONL adapter may be a path to an initial implementation, but it
must pass a real Workspace qualification test first: process kill during a
commit, Sandbox replacement, concurrent open/fencing, partial final record,
`fsync`/rename behavior, and monotonic readback of all acknowledged commits.
Pi documents a single-process ownership assumption and no cross-process lock;
the platform must enforce that assumption **per store**, not for an entire
Workspace. Distinct Sessions can own distinct stores in one Workspace at the
same time. Partitioning does not address two processes for the same Session
during replacement. If the platform already guarantees the old Sandbox has
stopped before a replacement starts, no extra fencing mechanism is needed for
that handoff; otherwise the storage layer needs an ownership/fencing protocol.
Pi does not automatically turn each conversation into a separate file-backed
store: its JSONL adapter takes a directory and writes one `main.jsonl` commit
stream for all conversations in that store, with task and document sidecars.
Its SQLite adapter takes one database file. Distinct Session processes can use
the same Workspace mount, but each must open a distinct Pi store path. A
Cantelop transactional storage adapter is the stronger long-term option and
can run Pi's published storage conformance suite. This is a platform decision,
not something the current SDK can guarantee by changing an example.

## Views and events terminology

Pi's **view** is a read-only projection of committed conversation state:
transcript entries plus documents such as `pi.live`, `pi.inbox`, `pi.agent`,
and `pi.usage`. `viewState()` gives the current value and subscriptions to
subsequent values. `watch()` gives that same current value plus the Chord
operations from each later commit. Pi also exposes views for the task graph
and individual app documents.

Pi's experimental **agent events** are a different presentation of those
commits for consumers accustomed to `message_start`, `message_update`, and
tool execution notifications. `watchEvents()` returns a snapshot followed by
event batches derived from later commits. Its deltas are live delivery, not a
persisted, seekable event log: a slow observer gets a fresh snapshot, and a
reconnecting observer starts from the current snapshot.

Cantelop's **Session events** are application-defined payloads passed to
`output.send()` and delivered by `session.events()` over SSE or WebSocket.
Their cursor and replay buffer belong to the transport and are activation
local. They do not reconstruct a Pi conversation or its task state after a
Sandbox replacement. A native adapter may carry Pi snapshots and updates over
that transport, but the client must identify them as Pi state messages and
reinitialize from a snapshot after a stream reset.

### Harness-neutral observation stream

Evolve the streaming layer with an opt-in **observation source** alongside
existing application output. A source exposes one atomic `open()` operation
that returns its current snapshot and a subscription to every subsequent
change. Pi's `watch()` or `watchEvents()` can implement it; another harness
could supply its own snapshot and update format. Cantelop should treat the
snapshot and change payloads as opaque, labelled data, not translate them into
Pi-specific types.

The transport envelope can distinguish `snapshot`, `change`, and existing
`output` messages. It needs a source ID (for example one conversation or task
graph), a payload format/version, and an activation-local stream epoch and
sequence. Within one epoch, a client applies changes in order. After a gap,
buffer overflow, process replacement, or reconnect that cannot replay every
change, it obtains a **new snapshot** and starts a new sequence. The transport
cursor is not a durable commit ID. Sources that have a stable state revision
may include it, but it is optional; Pi's adapter must not invent a persisted
revision from a transient stream sequence.

The atomic `open()` boundary matters: separately fetching a snapshot and then
subscribing can miss a commit between the two calls. Observation callbacks
must not block Pi commits on SSE/WebSocket backpressure. Give each subscriber
a bounded queue and replace undelivered changes with a fresh snapshot when it
falls behind. A snapshot may exceed the existing 64 KiB output-event limit,
so the observation path needs a separate size/chunking rule.

Keep `output.send()` and `session.events()` behavior compatible for existing
apps. A distinct `session.observe(source, request)` API could reuse the same
SSE/WebSocket transport machinery while making the snapshot contract explicit.
This observation feature solves client reconstruction only; Pi's storage,
resume, and background wake requirements remain separate release gates.

## Proposed native shape

1. Add a Session activation hook that receives identity and environment and
   completes before new messages are handled. Open one Pi `Harness` for the
   Session's isolated store, install the application's registry and models,
   reacquire its root conversation, then call `resume()` on every activation.
   The registry must be reinstalled on each process start; stored Pi agent
   selections refer to extension names.
2. Expose a lifecycle capability through which the harness reports committed
   pending work and its next wake time. Keep the Sandbox running while work is
   runnable, and reactivate it when delayed or background work becomes due.
   A user dispatch must not be the only wake source. Allow clean close after
   all Pi work is idle, without treating close as abort.
3. Add an application adapter, optionally `@cantelop/sdk/pi-durable`, that
   maps `SessionContext.message.id` to Pi `requestId`; maps prompt/steer/follow-up
   to `submit()`; and maps cancellation to Pi submission withdrawal or
   `conversation.abort()`. It should not copy Pi's inbox, task graph, agent
   configuration, or replay policy into Cantelop state.
4. Expose a committed snapshot endpoint and a live stream based on Pi's
   `viewState()`/`watch()` or `watchEvents()`. On reconnect, send a new snapshot.
   The Cantelop event cursor is transient and must not be presented as a
   durable Pi replay cursor.
5. Store Pi data under a Session-specific directory, even when several Sessions
   share one Workspace. Verify the platform's exclusive handoff for consecutive
   Sandboxes of the same Session. Add an ownership/fencing token tied to the
   Sandbox generation only if the old and new processes can overlap.

### Independently hosted background agents

Pi's v1.0.0 background-subagent example creates a child conversation and
background tasks inside **one Harness, one storage owner, and one process**. A
background task is an ownership boundary, not a process allocation. Cantelop
can offer a stronger infrastructure boundary by creating a child Session and
Sandbox for an independently hosted agent. Each Sandbox would run its own Pi
Harness and own its own store; its local mailbox/activity quiescence would
describe that child, not the parent's work. The parent could become idle and
release while the child continues.

This is a Cantelop-hosted subagent integration, not a transparent placement
policy for every Pi `background: true` task. Pi's built-in child ownership,
abort propagation, task graph, and atomic parent/child commits apply within one
Harness. Across Sandboxes, a Cantelop extension must explicitly persist the
child Session identity and desired action in the parent, create/send with
idempotency, and deliver completion back as a durable, deduplicated submission.
It must also define stop/abort and orphan cleanup. A cross-Sandbox transition
cannot be represented as one Pi storage commit unless a shared transactional
service is added. Work that remains inside a single Pi Harness still needs the
activation and wake contract above.

### Initial release scope

The example's `subagent` tool is application code packaged as an extension.
Cantelop need not install or expose it in the first Pi Durable integration, and
separate child Sandboxes can follow as an explicit hosted-agent capability.
Likewise, automatic background compaction can be disabled with Pi's
`compaction.backgroundTokens: 0` while its lifecycle is being integrated.

The Pi scheduler itself is not optional: even a single submitted input uses
durable generation and tool tasks. An initial release must resume those tasks
after replacement and must not declare the Sandbox quiescent while they are
executing. If the first release does not host arbitrary Pi background tasks,
state that as an explicit supported profile and install only extensions whose
task behavior is known to fit it. This is a scope limit, not full support for every
Pi Durable task API. Supporting those tasks later does not necessarily require
a child Sandbox; they can remain in one Harness if its lifecycle and wake
contract account for them.

The current `onRecover` remains useful for other applications, but it is not
the Pi integration point: its invocation is narrower than Pi's requirement to
resume whenever a stored harness is reopened.

## Release gates

- Pin exact Pi packages during this experimental period and run Pi's storage
  conformance suite against the selected backend.
- Kill and replace a Sandbox after each of: submission admission, partial model
  stream, safe tool execution, unsafe tool execution, queued follow-up, steer,
  child task creation, and app-document commit. Confirm no acknowledged input
  disappears and no unsafe effect reruns.
- Check that a conversation with only background or delayed work wakes and
  finishes without a subsequent HTTP request, including after idle release.
- Check that two Sessions in one Workspace remain isolated, and that an old
  Sandbox cannot write after replacement.
- For hosted child Sessions, interrupt the parent after recording child intent,
  after child creation, and after child completion but before reporting it.
  Confirm one child, one report, independent parent/child release, and defined
  abort propagation.
- Reconnect an observer after a stream reset and verify its snapshot matches
  Pi's committed transcript, inbox, task graph, and app documents.

## Sources

- [Pi Durable v1.0.0 README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)
- [Pi Durable v1.0.0 JSONL storage implementation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/storage/jsonl/storage.ts)
- [Pi Durable v1.0.0 specification](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/spec.md)
- [Pi Durable background-subagent example](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/examples/23-subagent-background.ts)
- [SQLite WAL documentation](https://www.sqlite.org/wal.html)
- Cantelop contracts: [Session behaviour](../src/session.ts),
  [runtime quiescence](../src/runtime-quiescence.ts),
  [activity](../src/activity.ts), and [Workspace description](../README.md).
