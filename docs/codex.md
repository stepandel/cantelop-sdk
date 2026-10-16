# Durable hosted Codex

The packaged integration follows the same App shape as Claude:

```ts
import { CantelopClient } from "@cantelop/sdk";
import { createCodexRuntime, createCodexAuth, codexDockerfile } from "@cantelop/sdk/harnesses/codex";
import type { CodexSessionCommand, CodexSessionEvent, CodexSessionReply, CodexSessionView } from "@cantelop/sdk/harnesses/codex/protocol";

export const app = new CantelopClient().app<CodexSessionCommand, CodexSessionEvent, CodexSessionReply, CodexSessionView>({
  name: "durable-codex",
  runtime: createCodexRuntime({ workspace: "/workspace", sandbox: "workspace-write", approvalPolicy: "never" }),
  auth: createCodexAuth({ workspace: "/workspace" }),
  dockerfile: codexDockerfile,
});
```

See [the runnable example](../examples/codex-durable/README.md). The image builds
an immutable revision of [the native fork](https://github.com/stepandel/cantelop-codex-native)
and installs a pinned stock Codex CLI for sign-in. The first image build includes
Rust compilation; no consumer files are needed by the Dockerfile. Native builds
and SDK releases remain independent. `CANTELOP_CODEX_PATH` selects the app-server;
`CODEX_PATH` selects the sign-in CLI. Both default to the packaged image's paths.

## Durable intake and recovery

`createCodexRuntime()` owns one logical store per Session in its Workspace database.
Intake, task statuses, native thread identity and observation sequence numbers are
committed before successful intake or publication. The runtime opts into platform
redelivery; task IDs remain the deduplication key across incarnations.

```ts
const session = app.workspace({ slug: verifiedUserId }).session({ id: conversationId });
await session.dispatch({ type: "queue", id: requestId, text: "Inspect the repository" });
await session.dispatch({ type: "steer", id: nextRequestId, text: "Focus on tests" });
await session.dispatch({ type: "cancel", id: requestId });
const state = await session.request({ type: "snapshot" });
```

- Keep the task ID stable on retries. Reusing it for different text, mode or settings
  fails. A completed or interrupted task is never executed again by redelivery.
- Accepted queued tasks resume on **every activation**, including ordinary idle
  release. Recovery does not require a new user prompt or only `onRecover`.
- A running task becomes `interrupted` after process loss. A committed cancellation
  or steering intent retains its corresponding terminal status after replacement.
- Steering commits a priority follow-up, interrupts the current native turn, waits
  for cleanup, then resumes the same native thread with the follow-up. It does not
  rely on an ambiguous in-flight `turn/steer` request.
- `model` and `systemPrompt` may be supplied as per-task `settings`; omitted values
  inherit immutable App defaults. Accepted settings are snapshotted, and removed
  from the work record after terminal status. Snapshots never expose settings.
- An owned activity holds the Sandbox while native work and persistence settle;
  its deadline is renewed. Queued work is drained before the runtime becomes idle.
- Failed or ambiguous SQL commits stop that store's writer and native execution.
  After cleanup, the runtime reopens the committed state while retaining activity
  ownership through a database outage. Only input known not to have entered native
  execution can restart automatically. Writes and native requests are never replayed.
  If intake loses its commit acknowledgment before activity starts, that invocation
  stays open until committed work is recovered and scheduled, without another message.

The Session retains at most 1,000 task identities, then rejects new intake.
Snapshots return the latest 50 statuses with text previews. Observation history
remains in SQL for replay; application retention/deletion is a separate concern.

## Codex and Pi Durable

This adopts Pi's durable admission, commit-before-publication, per-Session stores,
activation recovery, explicit ownership and committed observation principles.
Codex does **not** expose Pi's transactional task graph or per-tool replay safety.
Resuming a thread reopens a conversation; it does not safely resume an interrupted
tool checkpoint. The runtime therefore never automatically resubmits a running
prompt after a crash. Inspect the interrupted task and submit an explicit new
continuation when appropriate. Model output and external tool effects cannot be
committed atomically with the SDK inbox.

The supported execution unit is one foreground Codex turn. Native goals and
subagents are disabled by the runtime, including overrides in native config.
Delayed tasks, independently running agents and detached background processes require
their own durable ownership/wake protocol and are outside this runtime's contract.
Do not treat a foreground task's completion as their completion.
Approval requests are rejected unless explicitly handled by
the low-level client; the packaged runtime uses the configured native policy.

Canonical JSONL rollout replay, auth and config remain Workspace files. Keep
`CODEX_HOME` on the persistent volume. Native SQL stores use the Workspace database;
no live SQLite files belong on the network filesystem. Database-only model replay
would require another native ThreadStore implementation.

Before committing a task's completed status, the harness waits for native shutdown,
then synchronizes the canonical rollout file and its parent directories. A missing
rollout path or failed synchronization fails the task; it cannot be reported as a
durable completion. Partial-turn replay still follows Codex's interrupted-history
behavior, not Pi tool checkpoint semantics.

Opening a replacement fences the previous SDK state writer. The platform must
also stop the previous Sandbox before replacement native execution begins: a
database fence cannot revoke an external shell or MCP side effect. Different
Sessions in one Workspace have isolated inboxes, statuses and event histories.

## Committed observation

`session.view()` reads the last platform-committed `CodexSessionView` without
activating a Sandbox. It contains the native thread ID, the latest 50 task states
with bounded input previews, a truncation flag, and the SQL event cursor:

```ts
const view = await session.view();
renderTasks(view.state.messages);
```

The runtime commits SQL state first, then hands its projection to the platform,
before acknowledging intake or publishing related live events. These are two
separate commits: a crash between them can leave the view behind SQL. Every
activation repairs the projection from committed SQL, including interrupted task
status, before starting native work. Failed or ambiguous projection handoffs use
the same recovery path; they never cause the original mutation to run again.
Before the first activation creates a projection, `.view()` returns
`session_view_not_found`. Dispatch acknowledges transport admission before
application intake completes, so treat a missing first projection as a loading
state and retry the read. Afterward the last projection remains readable while
the Sandbox is stopped.

The view is a task summary; transcript content remains in the durable event log.
`view.state.cursor` is a SQL position, while `view.cursor` is the platform stream
boundary. Keep their cursors separate. The existing `snapshot` command returns
the same state but can activate a Sandbox.

Session SSE/WebSocket cursors remain transient transport positions. Each packaged
Codex event additionally has a durable, Session-local SQL `seq`. Publication is
bounded and best effort; disconnected/slow observers cannot block execution.

Page the committed log to initialize, reconnect or fill a live sequence gap:

```ts
let cursor = 0;
for (;;) {
  const page = await session.request({ type: "events", after: cursor, limit: 50 });
  if (page.type !== "session.events") throw new Error("Unexpected reply");
  for (const event of page.events) applyOnce(event.seq, event);
  cursor = page.cursor;
  if (!page.hasMore) break;
}
```

Attach the live stream before fetching pages, buffer arriving live events, then
deduplicate by `seq`. If any sequence is missing, fetch the SQL log from the last
contiguous sequence. The SQL log is authoritative, including when live delivery
fails. Each page fits the output frame limit; oversized native events are committed
as consecutive `codex.fragment` records. `CodexSessionOutput` from the browser-safe
protocol entry point reconstructs one task's native events. Persist each fragment's
sequence, or replay from before its first fragment after reconnect. Native events
larger than 4 MiB fail the task explicitly rather than exhausting observer memory.

## Workspace sign-in

```ts
const workspace = app.workspace({ slug: verifiedUserId });
const login = await workspace.auth().login();
if (!login.authenticated) {
  showDeviceLogin(login.url, login.userCode);
  // Poll workspace.auth().status() until authenticated.
}
```

The stock CLI prints the allowed OpenAI URL and one-time device code. The SDK
returns only those structured fields; native diagnostics remain private and are
never journaled. The user enters the code on OpenAI's page. There is no pasted
code to submit through `auth.submitCode()`. The native process completes sign-in
and releases its idle hold. Cancellation and expiry stop unfinished attempts.
Device sign-in must be enabled for the user's ChatGPT account/workspace.

## Lower-level execution

`createCodexHarness(context, options)` implements `queue`, `steer` and `cancel`, like
the Claude harness. It owns native process cleanup and conversation resumption;
its direct input queue is incarnation-local. Use `createCodexRuntime` for durable
intake and observations. `@cantelop/sdk/codex` retains the raw app-server client,
explicit approval handler, and renewable workspace SQL bridge.

The native executable must advertise storage protocol 1, backend `workspace`,
`localSqlite: false` and all required storage domains. Stock/partial executables
are rejected before starting an app-server or opening the database. The child
gets a private loopback capability instead of the platform credential-broker token.
Harness children do not inherit host provider credentials. Completion waits for
native persistence, shutdown and process-group cleanup.

## Verification

```sh
pnpm test
pnpm check:examples
pnpm check:package
CANTELOP_CODEX_PATH=/path/to/cantelop-codex pnpm check:codex-harness
```

Tests cover process kill after an unsafe effect, queued-work recovery, idempotent
intake, writer fencing, ambiguous commits, cancellation/steering, Session isolation,
observer disconnect and fragmented event replay. The real native qualification
uses a mocked model provider with no paid API calls or user credentials. It covers
native migrations/storage, completed turns, replacement-process resume, concurrent
shutdown, the packaged runtime and redelivery without another model call.

Sources: [Pi assessment](pi-durable-support.md),
[native fork contract](https://github.com/stepandel/cantelop-codex-native/blob/cantelop/cantelop/README.md),
[official Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).
