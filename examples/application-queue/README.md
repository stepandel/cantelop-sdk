# Application owned queue example

`createPersistentAgent({ run, steer })` demonstrates application-owned queue,
steering, cancellation, intake deduplication, and checkpoint recovery using
`context.database()`. Pass the returned behaviour to `serveSessionRuntime`.
It is a reference for integrating your agent provider; it requires no provider
package of its own.

`run(prompt, { signal, output, steers, checkpoint, saveCheckpoint })` runs in
tracked activity. `steer(prompt)` notifies the currently running agent. The
application commits each command and its message receipt before `receive`
returns. A repeated command ID produces no second queue or cancellation update.
The Session ID partitions tables within the Workspace database.

This application's explicit restart policy is to resume interrupted jobs from
checkpoints and supply persisted steering input to the replacement run. Provider
calls and external side effects may repeat after a crash. Applications that need
other policies should store an uncertain outcome or use idempotent side effects.
Live steering is cooperative; its database commit and provider notification are
not an atomic transaction. The stored steer is available to recovery.

Cancellation records queued and running jobs as cancelled before signalling the
worker. The agent must honor its AbortSignal. New queued input waits for the old
activity to settle. Each fresh incarnation restores pending work before intake;
this does not add a wake scheduler for future jobs.

`send({ type: "wake" })` is an internal in-memory completion notification. The
persistent queue remains the source of pending jobs if that notification is lost.
Intake receipts and completed jobs need an application retention policy in a
long-lived deployment. Output keeps the runtime's existing stream semantics.
