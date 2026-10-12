# Stock OpenCode CLI harness

This example follows the [claude-code-api native runner pattern](https://github.com/stepandel/claude-code-api/blob/ce9d80b12f0b69c6823fd78960815752f3796eeb/src/claude.ts). It starts the published, unmodified CLI for each turn, supplies the prompt through stdin, forwards native JSON events and resumes the provider's existing conversation. It uses no provider SDK transport or replacement agent loop.

```text
opencode run --format json [--session SESSION_ID]
```

The `create` factory returns a session-scoped `NativeOpenCode` runner directly. Each runner implements Cantelop’s `SessionHarness` interface, `run(message, work)`. An existing runner implementing that interface can be returned directly too:
```ts
runtime: {
  create(context) {
    return createExistingNativeRunner(context);
  },
  steering: "interrupt",
}
```

Cantelop owns queueing. `session.dispatch()` schedules FIFO input; `session.steer()` admits priority input and interrupts the active turn. Work remains in the execution slot until the CLI and its process group exit, then the steering prompt resumes the same native conversation before ordinary queued work. Steering submissions retain FIFO order within their priority. `session.cancel()` interrupts the active operation and preserves queued input; it takes no target message ID.

Cancellation sends SIGTERM and escalates to SIGKILL after one second. Cleanup also runs on parsing/output failures and waits for the actual subprocess before returning. Process-group cleanup targets Linux/macOS Sandbox processes; tools that detach into a different group require broader Sandbox cleanup. Prompts stay out of command arguments, and stderr is never published.

## Native authentication and state

Use OpenCode's own login in the user's Workspace, for example `XDG_DATA_HOME=/workspace/.local/share XDG_CONFIG_HOME=/workspace/.config HOME=/workspace opencode auth login`. The adapter does not collect tokens or inject inherited API keys. Native provider credentials and configuration remain provider-owned. The child environment is scoped to the Workspace; the host's auth/config environment is unchanged.

OpenCode auth lives at `/workspace/.local/share/opencode/auth.json`, with native configuration under `/workspace/.config/opencode`. The live native SQLite database is created on local disk per runtime incarnation. Native auth files are linked into that local data directory without reading their credentials. After every known-session turn (including interruption), the adapter runs stock `opencode export` and atomically saves the native snapshot under `.cantelop/native-harness/opencode`. A replacement incarnation restores it through stock `opencode import`, then resumes the recorded session ID. The snapshot is capped at 16 MiB; export/import failures surface rather than silently discarding state.

The Cantelop Session-to-native-conversation mapping is saved atomically in a private file under `/workspace/.cantelop/native-harness`. Different Cantelop Sessions sharing a Workspace retain independent provider conversation IDs. These examples do not replay interrupted turns or make the SDK's waiting queue durable. Application-owned pending jobs and recovery policy remain separate; see [the application queue example](../application-queue/README.md).

## Configuration and output

`OPENCODE_PATH` defaults to `/usr/local/bin/opencode`; override it for a local installation. `OPENCODE_MODEL` is optional and otherwise preserves native model configuration. Configure native tools, prompts, permissions and MCPs through the harness's own files/options. The Docker image installs the pinned stock CLI declared in `package.json` under `nativeCli`.

`session.stream()` carries native JSON objects. Frames over 48 KiB are emitted as `native.fragment` objects with `eventId`, `index`, `total` and `json`; concatenate fragments in order and parse the reconstructed JSON. Subscribe before dispatching for live output or use retained replay.

Run `pnpm check:examples` from the SDK root to type-check and qualify backend/Edge/native artifacts. Tests use executable CLI fixtures, including stubborn tool subprocesses; they require no real credentials or model calls.
