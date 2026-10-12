# Stock Claude Code CLI harness

This example runs the published, unmodified CLI for each turn, supplies the prompt through stdin, forwards native JSON events and resumes the provider's existing conversation.

```text
claude -p --output-format stream-json --verbose --include-partial-messages [--session-id ID | --resume ID]
```

The `create` factory returns a session-scoped `NativeClaude` runner directly. Each runner implements Cantelop’s `SessionHarness` interface, `queue(message, work)`, `steer(message, work)` and `cancel()`. An existing runner implementing that interface can be returned directly too:
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

The App exposes the stock Claude Code login through `workspace.auth()`. Resolve the Workspace from your verified user identity, then offer the returned URL and accept the code in your own API/UI:

```ts
const auth = app.workspace({ slug: verifiedUserWorkspace }).auth();
const methods = await auth.methods(); // ["browser-code"]
const authenticated = await auth.status();
const attempt = await auth.login({ method: "browser-code" });
if (attempt.type === "login") {
  // Show attempt.url, then collect the code from the user.
  await auth.submit({ attemptId: attempt.attemptId, code });
}
```

`auth.login()` returns `{ type: "status", authenticated: true }` when the user is already signed in. Use `auth.cancel({ attemptId })` to stop an unfinished login and `auth.logout()` to run the native logout and verify its result. An attempt expires after ten minutes and is lost if its Sandbox is replaced; start another login in that case. The SDK uses one reserved auth Session per Workspace, so agent Sessions share the resulting credentials. Retrying an ambiguous call with the same `{ id }` preserves its command identity.

The adapter invokes Claude's own `auth status`, `auth login`, and `auth logout`. A private PTY relay supports interactive login; raw terminal output and code input are never published as Session events. The adapter does not collect tokens or inject inherited API keys. Native credentials remain under the Workspace's `.claude` directory. The child environment is scoped to the Workspace; the host's auth/config environment is unchanged.

Claude owns `/workspace/.claude`, including native login and conversation files. The adapter allocates a native conversation UUID, saves it, and marks it resumable when Claude emits `system/init`. Subsequent turns use `--resume` for that same conversation.

The Cantelop Session-to-native-conversation mapping is saved atomically in a private file under `/workspace/.cantelop/native-harness`. Different Cantelop Sessions sharing a Workspace retain independent provider conversation IDs. These examples do not replay interrupted turns or make the example’s waiting queue durable. Application-owned pending jobs and recovery policy remain separate; see [the application queue example](../application-queue/README.md).

## Configuration and output

`CLAUDE_PATH` defaults to `/usr/local/bin/claude`; override it for a local installation. `CLAUDE_MODEL` is optional and otherwise preserves native model configuration. Configure native tools, prompts, permissions and MCPs through the harness's own files/options. The Docker image installs the pinned stock CLI declared in `package.json` under `nativeCli`.

`session.stream()` carries native JSON objects. Frames over 48 KiB are emitted as `native.fragment` objects with `eventId`, `index`, `total` and `json`; concatenate fragments in order and parse the reconstructed JSON. Subscribe before dispatching for live output or use retained replay.

Run `pnpm check:examples` from the SDK root to type-check and qualify backend/Edge/native artifacts. Tests use executable CLI fixtures, including stubborn tool subprocesses; they require no real credentials or model calls.
