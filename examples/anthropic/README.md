# Stock Claude Code CLI harness

This example runs the published, unmodified CLI for each turn, supplies the prompt through stdin, forwards native JSON events and resumes the provider's existing conversation.

```text
claude -p --output-format stream-json --verbose --include-partial-messages [--session-id ID | --resume ID]
```

The harness, native auth provider, and self-contained Dockerfile are shipped with `@cantelop/sdk`. No copied provider implementation or Docker assets are needed:

```ts
import { CantelopClient } from "@cantelop/sdk";
import {
  createClaudeHarness, claudeAuth, claudeDockerfile,
  type ClaudeMessage, type ClaudeEvent,
} from "@cantelop/sdk/harnesses/claude";

export const app = new CantelopClient().app<ClaudeMessage, ClaudeEvent>({
  name: "claude-agent",
  runtime: { create: createClaudeHarness },
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
  environment: {
    CLAUDE_PATH: { default: "/usr/local/bin/claude" },
    CLAUDE_MODEL: {},
  },
});
```

`claudeDockerfile` is a project-relative path under `node_modules/@cantelop/sdk`. Install the SDK in the project root before building or deploying. The image installs Node 22, the pinned stock Claude CLI, Python, git, ripgrep, and the login PTY helper. The helper is embedded in the Dockerfile, so Docker needs no `COPY` from your project or its `node_modules`. Updating the SDK updates the harness and image together.

For a custom image, resolve the packaged Dockerfile with `import.meta.resolve("@cantelop/sdk/harnesses/claude/Dockerfile")`, copy it into your project, extend it, and set `dockerfile` to the local path. That copy then becomes application-maintained.

The `createClaudeHarness` factory returns a session-scoped `NativeClaude` runner directly. Each runner implements Cantelop’s `SessionHarness` interface, `queue(message, work)`, `steer(message, work)` and `cancel()`. An existing runner implementing that interface can be returned directly too:
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

The App declares `auth: claudeAuth` ([src/auth.ts](src/auth.ts)), so each Workspace can sign in to Claude with the user's own subscription. Resolve the Workspace from your verified user identity, then hand the returned terminal to that user's browser:

```ts
const auth = app.workspace({ slug: verifiedUserWorkspace }).auth();
if (!await auth.status()) {
  const { url, protocols } = await auth.terminal();
  // Browser: new WebSocket(url, protocols), rendered with a terminal such as xterm.js.
}
```

The browser shows the stock `claude auth login` in its own PTY. The user opens Anthropic's sign-in page and pastes the code into the CLI. Every sign-in method the CLI offers stays available. Your backend and the Session never see the code or the credentials. Afterwards, `auth.status()` reports the result. `auth.close({ terminalId })` ends an unfinished login, and `auth.logout()` runs the native logout. See [native auth](../../docs/native-auth.md) for the browser snippet, lifecycle and protocol.

The provider runs Claude's own `auth status`, `auth login` and `auth logout` with the Workspace-scoped environment. The packaged `login-pty.py` gives the CLI a real terminal, applies resizes, and relays bytes without recording them. Native credentials remain under the Workspace's `.claude` directory, so every Session in the Workspace uses them. The adapter does not inject inherited API keys, and the host's auth/config environment is unchanged.

Claude owns `/workspace/.claude`, including native login and conversation files. The adapter allocates a native conversation UUID, saves it, and marks it resumable when Claude emits `system/init`. Subsequent turns use `--resume` for that same conversation.

The Cantelop Session-to-native-conversation mapping is saved atomically in a private file under `/workspace/.cantelop/native-harness`. Different Cantelop Sessions sharing a Workspace retain independent provider conversation IDs. These examples do not replay interrupted turns or make the example’s waiting queue durable. Application-owned pending jobs and recovery policy remain separate; see [the application queue example](../application-queue/README.md).

## Configuration and output

`CLAUDE_PATH` defaults to `/usr/local/bin/claude`; override it for a local installation. `CLAUDE_MODEL` is optional and otherwise preserves native model configuration. Configure native tools, prompts, permissions and MCPs through the harness's own files/options. The SDK maintains the CLI pin in `assets/claude/Dockerfile`. For custom construction, import `NativeClaude` and `ClaudeHarnessOptions` from the same harness subpath; pass `{ workspace, sessionId, binary, model? }` and the runtime lifetime signal to the constructor. Optional `tools`, `allowedTools`, `permissionMode`, `settingSources`, `maxTurns`, `mcps`, and `systemPrompt` preserve application execution restrictions. A `conversation: { id, resumable }` seed migrates an existing native conversation once; persisted SDK state takes precedence. System prompts use private temporary files removed after the turn.

`session.stream()` carries native JSON objects. Frames over 48 KiB are emitted as `native.fragment` objects with `eventId`, `index`, `total` and `json`; concatenate fragments in order and parse the reconstructed JSON. Subscribe before dispatching for live output or use retained replay.

Run `pnpm check:examples` from the SDK root to type-check and qualify backend/Edge/native artifacts. Tests use executable CLI fixtures, including stubborn tool subprocesses; they require no real credentials or model calls.
