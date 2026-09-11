# Supervised long-running agents

`receive` has a five-minute execution deadline. Return after `activity.start` to
run longer work under an activity deadline (30 minutes in this example, maximum
24 hours). Keep-alive controls idle lifetime; it does not extend either deadline.

`session.mjs` exports a credential-free example with an injected agent function.
Use a persistent Workspace directory for `outcomeDirectory`. Each outcome is
written by temporary-file rename, keyed by the original prompt message. On
startup, reconcile missing outcomes with platform traces: a killed sandbox may
never execute `finally`. The in-memory prompt queue does not survive VM loss;
applications needing durable queued work must persist that queue too.

```js
import { createSupervisedAgent } from './session.mjs';
import { runSubprocess } from './subprocess.mjs';

export default createSupervisedAgent({
  outcomeDirectory: '/workspace/outcomes',
  run: (prompt, activity) => runSubprocess(['my-agent', '--prompt', prompt], activity),
});
```

While an activity runs, `receive` continues accepting messages. This example
queues `prompt` messages in arrival order. A `cancel` message discards queued
prompts and aborts the current activity. An internal `drain` message launches the
next queued prompt after the previous activity settles. Do not await the activity
inside `receive`, and do not use the receive context's signal or output for work
that outlives it. Await `activity.output.send` for output handoff and backpressure.
The Bun subprocess adapter drains stdout and stderr concurrently and kills/reaps
the child on cancellation or output failure. A blocked output must reject when
the activity signal aborts (the SDK's output capability does this).

Activity telemetry includes `started`, `completed`, `failed`,
`cancellation_requested`, and `cancelled` with activity and originating message
IDs. Cancellation requested does not mean the work has stopped: the activity
remains active until its promise settles. Cancellation wins the final outcome
when an aborted promise rejects. Telemetry is bounded and best effort; it does
not replace persisted application outcomes. Raw exceptions are not copied into
these lifecycle records. A successful launch-message receipt stays successful
if its activity later fails.

Run `pnpm test` for lifecycle and queue integration coverage, and
`bun test test/bun-subprocess.test.mjs` for real Bun subprocess and HTTP health
coverage. These tests need no provider credentials or OpenCode installation.
