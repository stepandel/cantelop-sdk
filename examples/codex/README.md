# Stock Codex CLI harness

This example follows the [claude-code-api native runner pattern](https://github.com/stepandel/claude-code-api/blob/ce9d80b12f0b69c6823fd78960815752f3796eeb/src/claude.ts). It starts the published, unmodified CLI for each turn, supplies the prompt through stdin, forwards native JSON events and resumes the provider's existing conversation. It uses no provider SDK transport or replacement agent loop.

```text
codex exec --json [resume THREAD_ID] -
```

The `create` factory wraps a session-scoped `NativeCodex` runner. To use a runner you already own, import `wrapCodex` from `src/agent.ts` and adapt its `run({ text, signal, emit })` method:

```ts
runtime: {
  create(context) {
    return wrapCodex(createExistingNativeRunner(context), context.signal);
  },
  steering: "interrupt",
}
```

Cantelop owns queueing. `session.dispatch()` schedules FIFO input; `session.steer()` admits priority input and interrupts the active turn. Work remains in the execution slot until the CLI and its process group exit, then the steering prompt resumes the same native conversation before ordinary queued work. Steering submissions retain FIFO order within their priority. `session.cancel()` interrupts the active operation and preserves queued input; it takes no target message ID.

Cancellation sends SIGTERM and escalates to SIGKILL after one second. Cleanup also runs on parsing/output failures and waits for the actual subprocess before returning. Process-group cleanup targets Linux/macOS Sandbox processes; tools that detach into a different group require broader Sandbox cleanup. Prompts stay out of command arguments, and stderr is never published.

## Native authentication and state

Use Codex's own login in the user's Workspace, for example `CODEX_HOME=/workspace/.codex HOME=/workspace codex login`. The adapter does not collect tokens or inject inherited API keys. Native provider credentials and configuration remain provider-owned. The child environment is scoped to the Workspace; the host's auth/config environment is unchanged.

Codex auth, configuration and native rollout files use `/workspace/.codex`. `CODEX_SQLITE_HOME` defaults to a local cache directory; the native `sqlite_home` configuration takes precedence. The adapter saves the `thread.started` ID and resumes that exact thread instead of selecting the most recent conversation.

The Cantelop Session-to-native-conversation mapping is saved atomically in a private file under `/workspace/.cantelop/native-harness`. Different Cantelop Sessions sharing a Workspace retain independent provider conversation IDs. These examples do not replay interrupted turns or make the SDK's waiting queue durable. Application-owned pending jobs and recovery policy remain separate; see [the application queue example](../application-queue/README.md).

## Configuration and output

`CODEX_PATH` defaults to `/usr/local/bin/codex`; override it for a local installation. `CODEX_MODEL` is optional and otherwise preserves native model configuration. Configure native tools, prompts, permissions and MCPs through the harness's own files/options. The Docker image installs the pinned stock CLI declared in `package.json` under `nativeCli`.

`session.stream()` carries native JSON objects. Frames over 48 KiB are emitted as `native.fragment` objects with `eventId`, `index`, `total` and `json`; concatenate fragments in order and parse the reconstructed JSON. Subscribe before dispatching for live output or use retained replay.

Run `pnpm check:examples` from the SDK root to type-check and qualify backend/Edge/native artifacts. Tests use executable CLI fixtures, including stubborn tool subprocesses; they require no real credentials or model calls.
