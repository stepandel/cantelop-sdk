# Stock OpenCode CLI harness

This example runs the published, unmodified CLI for each turn, supplies the prompt through stdin, forwards native JSON events and resumes the provider's existing conversation.

```text
opencode run --format json [--session SESSION_ID]
```

The `create` factory returns a session-scoped `NativeOpenCode` runner directly. Each runner implements Cantelop’s `SessionHarness` interface, `queue(message, work)`, `steer(message, work)` and `cancel()`. An existing runner implementing that interface can be returned directly too:
```ts
runtime: {
  create(context) {
    return createExistingNativeRunner(context);
  },
}
```

The app registers its factory. The runner owns queueing and implements steering by interrupting its active CLI turn and admitting priority input. `session.dispatch()` schedules FIFO input; `session.steer()` admits priority input and interrupts the active turn. Work remains in the execution slot until the CLI and its process group exit, then the steering prompt resumes the same native conversation before ordinary queued work. Steering submissions retain FIFO order within their priority. `session.cancel()` interrupts the active operation and preserves queued input; it takes no target message ID.

Cancellation sends SIGTERM and escalates to SIGKILL after one second. Cleanup also runs on parsing/output failures and waits for the actual subprocess before returning. Process-group cleanup targets Linux/macOS Sandbox processes; tools that detach into a different group require broader Sandbox cleanup. Prompts stay out of command arguments, and stderr is never published.

## Native authentication and state

The App declares `auth: opencodeAuth` ([src/auth.ts](src/auth.ts)), so each Workspace can store its own provider credential with OpenCode's stock login. Resolve the Workspace from your verified user identity, then hand the returned terminal to that user's browser:

```ts
const auth = app.workspace({ slug: verifiedUserWorkspace }).auth();
if (!await auth.status()) {
  const { url, protocols } = await auth.terminal();
  // Browser: new WebSocket(url, protocols), rendered with a terminal such as xterm.js.
}
```

The browser shows `opencode auth login --provider <id>` in its own PTY, and the user completes OpenCode's own prompts there. `OPENCODE_LOGIN_PROVIDER` picks the provider (default `opencode`). It must appear in `OPENCODE_LOGIN_PROVIDERS` in [src/auth.ts](src/auth.ts). Anthropic is deliberately excluded: Anthropic does not allow Claude subscription sign-in through third-party tools, so use the [Claude Code example](../anthropic/README.md) instead. Before adding a provider, confirm that its terms allow hosted use, especially for subscription (OAuth) methods. `auth.status()` checks whether OpenCode's credential file has an entry for that provider, and `auth.logout()` runs `opencode auth logout <provider>`. See [native auth](../../docs/native-auth.md) for the browser snippet and lifecycle.

The adapter does not collect tokens or inject inherited API keys. The child environment is scoped to the Workspace; the host's auth/config environment is unchanged.

OpenCode auth lives at `/workspace/.local/share/opencode/auth.json`, with native configuration under `/workspace/.config/opencode`. The live native SQLite database is created on local disk per runtime incarnation. Native auth files are linked into that local data directory without reading their credentials. After every known-session turn (including interruption), the adapter runs stock `opencode export` and atomically saves the native snapshot under `.cantelop/native-harness/opencode`. A replacement incarnation restores it through stock `opencode import`, then resumes the recorded session ID. The snapshot is capped at 16 MiB; export/import failures surface rather than silently discarding state.

The Cantelop Session-to-native-conversation mapping is saved atomically in a private file under `/workspace/.cantelop/native-harness`. Different Cantelop Sessions sharing a Workspace retain independent provider conversation IDs. These examples do not replay interrupted turns or make the example’s waiting queue durable. Application-owned pending jobs and recovery policy remain separate; see [the application queue example](../application-queue/README.md).

## Configuration and output

`OPENCODE_PATH` defaults to `/usr/local/bin/opencode`; override it for a local installation. `OPENCODE_MODEL` is optional and otherwise preserves native model configuration. Configure native tools, prompts, permissions and MCPs through the harness's own files/options. The Docker image installs the pinned stock CLI declared in `package.json` under `nativeCli`.

`session.stream()` carries native JSON objects. Frames over 48 KiB are emitted as `native.fragment` objects with `eventId`, `index`, `total` and `json`; concatenate fragments in order and parse the reconstructed JSON. Subscribe before dispatching for live output or use retained replay.

Run `pnpm check:examples` from the SDK root to type-check and qualify backend/Edge/native artifacts. Tests use executable CLI fixtures, including stubborn tool subprocesses; they require no real credentials or model calls.
