# Durable hosted Codex

The SDK owns committed input, task status, native thread binding, recovery and
replayable observations. The packaged image builds the pinned native Codex fork;
its first build includes Rust compilation. The stock CLI handles Workspace sign-in.

```sh
pnpm install
cantelop dev
```

From your backend, using `app` from `src/cantelop.ts`:

```ts
const workspace = app.workspace({ slug: verifiedUserId });
const login = await workspace.auth().login();
if (!login.authenticated) {
  // Show login.url and login.userCode. The user enters the code on OpenAI's page.
  // Poll workspace.auth().status(); do not call submitCode() for device login.
}
const session = workspace.session({ id: conversationId });
await session.dispatch({ type: "queue", id: requestId, text: "Inspect this repository" });
const snapshot = await session.view();
// snapshot.state contains recent task states and the durable SQL event cursor.
```

Keep `requestId` stable when retrying intake. Use `steer` to commit a priority
follow-up and interrupt the current task, or `cancel` with a task ID. On process
replacement, queued tasks resume and a running task becomes `interrupted`.
Codex has no safe per-tool checkpoint replay; inspect an interrupted task before
explicitly submitting a new continuation.

For reconnects, page `session.request({ type: "events", after: cursor })` until
`hasMore` is false. Each committed event has a stable `seq`; deduplicate live and
replayed delivery by that sequence. `CodexSessionOutput` from the browser-safe
protocol entry point decodes oversized native events.

`.view()` reads the last committed task summary without activating a Sandbox,
including after stop. Before the first activation it returns `session_view_not_found`.
Dispatch acceptance can precede that first projection; treat this error as a loading
state and retry the read.
The view's `state.cursor` belongs to the SQL event log; its outer `cursor` belongs
to the platform stream. Transcript events remain in SQL rather than the bounded view.

See [the durability contract](../../docs/codex.md) for storage, ownership, observation
and Codex limitations. The [stock CLI example](../codex/README.md) remains available
for applications that own their own durable intake.
