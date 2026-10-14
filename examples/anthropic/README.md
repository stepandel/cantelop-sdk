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

## Per-Session configuration

The same SDK factory accepts optional configuration when an application chooses
permissions, MCP servers, prompts or models for each Session:

```ts
import { createClaudeHarness, type ClaudeHarnessFactoryOptions } from "@cantelop/sdk/harnesses/claude";
import type { SessionHarnessContext } from "@cantelop/sdk/session";

export function create(context: SessionHarnessContext) {
  const settings: ClaudeHarnessFactoryOptions = {
    permissionMode: "dontAsk",
    settingSources: [],
    tools: [],
    allowedTools: ["mcp__project__*"],
    mcps: { project: { type: "http", url: "https://tools.example/mcp" } },
    systemPrompt: "Work through the supplied project tools.",
    maxTurns: 24,
    model: "sonnet",
  };
  return createClaudeHarness(context, settings);
}
```

Load application-owned durable configuration before creating the harness. It is
snapshotted when the factory runs; editing the original objects does not change a
live Session. Omit the second argument to retain the default factory behavior.
`binary`/`model` override `CLAUDE_PATH`/`CLAUDE_MODEL`; `workspace` defaults to the
mounted working directory. The canonical Session ID always comes from `context`.
The optional `conversation` seed imports an existing native conversation only
when SDK state is absent; existing SDK state takes precedence.

Applications with durable job queues can also use this factory inside a managed
activity and call the returned harness's public `queue`, `steer` and `cancel`
methods. Forward its output unchanged or add application message attribution.
Large output arrives as `native.fragment`; the SDK owns fragmentation, subprocess
parsing and cleanup. Keep the factory context signal tied to the runtime
incarnation, and the work signal tied to the individual activity/submission.

### Durable Session lifecycle

Applications that need App-declared settings, persistent queueing, targeted cancellation, snapshots and recovery can declare the packaged runtime instead of implementing a behaviour:

```ts
import { CantelopClient } from "@cantelop/sdk";
import { createClaudeRuntime, claudeAuth, claudeDockerfile } from "@cantelop/sdk/harnesses/claude";
import type { ClaudeSessionCommand, ClaudeSessionEvent, ClaudeSessionReply } from "@cantelop/sdk/harnesses/claude/protocol";

export const agent = new CantelopClient().app<ClaudeSessionCommand, ClaudeSessionEvent, ClaudeSessionReply>({
  name: "durable-claude",
  runtime: createClaudeRuntime({
    workspace: "/workspace", permissionMode: "dontAsk", settingSources: [],
    tools: ["Read"], allowedTools: ["Read"], mcps: {},
    model: "sonnet", systemPrompt: "Investigate issues and report your findings.", maxTurns: 24,
  }),
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
});
```

Declare tools, allowed tools, MCPs, model, system prompt and turn limit in `createClaudeRuntime(...)` at App initialization. Dispatch `{type:"queue",id,text}` immediately; no configuration request is needed. Omitted settings retain native defaults and environment fallbacks. Explicit `tools: []` disables tools and `mcps: {}` disables external MCPs. The runtime uses `createClaudeHarness` internally once per incarnation. Its settings, MCP credentials and permission defaults are snapshotted.

The SDK persists Session configuration, history and pending IDs atomically under `<workspace>/.cantelop/<hashed-session-id>.json`. On each activation, App settings replace any legacy Session configuration while retaining conversation history and pending work. This format supports migration from existing durable Claude integrations. Running work becomes `interrupted` on replacement and is never replayed; queued work resumes on recovery. `steer` interrupts the active turn and prioritizes its new input after native cleanup. `cancel` targets a queued or active ID. History is bounded to 1,000 messages; snapshots contain the latest 50 previews. Events use the exported Session protocol, including attributed Claude fragments and `auth.required`. Authorize queue/steer/cancel requests on the application backend.

### Link-and-code sign-in

`claudeAuth` includes the SDK's structured native login adapter. On your backend:

```ts
const auth = agent.workspace({ slug: "customer" }).auth();
const login = await auth.login({ force: false });
if (!login.authenticated) {
  // Return this link and attempt ID to your sign-in form.
  console.log(login.url, login.attemptId);
  // Submit the returned code with auth.submitCode({ attemptId: login.attemptId, code }).
  // Cancel an abandoned attempt with auth.cancelLogin({ attemptId: login.attemptId }).
}
```

No terminal component or WebSocket transport is needed for this flow. The SDK
starts the unmodified CLI privately and waits for its link and code prompt.
A rejected code leaves the same attempt available for retry. A completed code
requires fresh native status before authentication succeeds. Output stays in
bounded Session memory and is never returned to the application. Codes are
validated and written only to that attempt's stdin; credentials remain in the
Workspace. The terminal API described above remains an explicit low-level option.
