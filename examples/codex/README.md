# Stock Codex CLI harness

This example runs the published, unmodified CLI for each turn, supplies the prompt through stdin, forwards native JSON events and resumes the provider's existing conversation.

```text
codex exec --json [resume THREAD_ID] -
```

The `create` factory returns a session-scoped `NativeCodex` runner directly. Each runner implements Cantelop’s `SessionHarness` interface, `queue(message, work)`, `steer(message, work)` and `cancel()`. An existing runner implementing that interface can be returned directly too:
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

The App declares `auth: codexAuth` ([src/auth.ts](src/auth.ts)), so each Workspace can sign in to Codex with the user's own ChatGPT plan. Resolve the Workspace from your verified user identity, then hand the returned terminal to that user's browser:

```ts
const auth = app.workspace({ slug: verifiedUserWorkspace }).auth();
if (!await auth.status()) {
  const { url, protocols } = await auth.terminal();
  // Browser: new WebSocket(url, protocols), rendered with a terminal such as xterm.js.
}
```

The browser shows the stock `codex login --device-auth` in its own PTY. The CLI prints a link and a one-time code. The user enters the code on OpenAI's own page, and the CLI completes the sign-in by itself, so nothing is pasted into the terminal. Device-code login must first be enabled in the user's ChatGPT security settings, or by a workspace admin. `auth.status()` runs `codex login status`, and `auth.logout()` runs `codex logout`. See [native auth](../../docs/native-auth.md) for the browser snippet and lifecycle.

OpenAI's docs don't yet say whether a hosting platform may offer ChatGPT-plan sign-in, so confirm with OpenAI before offering it to users. The adapter does not collect tokens or inject inherited API keys. The child environment is scoped to the Workspace; the host's auth/config environment is unchanged.

Codex auth, configuration and native rollout files use `/workspace/.codex`. `CODEX_SQLITE_HOME` defaults to a local cache directory; the native `sqlite_home` configuration takes precedence. The adapter saves the `thread.started` ID and resumes that exact thread instead of selecting the most recent conversation.

The Cantelop Session-to-native-conversation mapping is saved atomically in a private file under `/workspace/.cantelop/native-harness`. Different Cantelop Sessions sharing a Workspace retain independent provider conversation IDs. These examples do not replay interrupted turns or make the example’s waiting queue durable. Application-owned pending jobs and recovery policy remain separate; see [the application queue example](../application-queue/README.md).

## Configuration and output

`CODEX_PATH` defaults to `/usr/local/bin/codex`; override it for a local installation. `CODEX_MODEL` is optional and otherwise preserves native model configuration. Configure native tools, prompts, permissions and MCPs through the harness's own files/options. The Docker image installs the pinned stock CLI declared in `package.json` under `nativeCli`.

`session.stream()` carries native JSON objects. Frames over 48 KiB are emitted as `native.fragment` objects with `eventId`, `index`, `total` and `json`; concatenate fragments in order and parse the reconstructed JSON. Subscribe before dispatching for live output or use retained replay.

Run `pnpm check:examples` from the SDK root to type-check and qualify backend/Edge/native artifacts. Tests use executable CLI fixtures, including stubborn tool subprocesses; they require no real credentials or model calls.
