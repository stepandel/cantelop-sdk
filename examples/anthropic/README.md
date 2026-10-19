# Claude Code

The packaged runtime runs stock Claude Code with native streaming input. Input starts a run while idle and steers ongoing work while busy. Accepted inputs and observations survive replacement in the Workspace, and `.view()` reconstructs the public conversation without starting a Sandbox.

## Define the App

```ts
import { CantelopClient } from "@cantelop/sdk";
import {
  createClaudeRuntime, claudeAuth, claudeDockerfile,
  type ClaudeSessionCommand, type ClaudeSessionEvent,
  type ClaudeSessionReply, type ClaudeSessionView,
} from "@cantelop/sdk/harnesses/claude";

export const app = new CantelopClient().app<
  ClaudeSessionCommand, ClaudeSessionEvent, ClaudeSessionReply, ClaudeSessionView
>({
  name: "anthropic",
  runtime: createClaudeRuntime({
    permissionMode: "dontAsk", settingSources: [],
    tools: ["Read", "Glob", "Grep"], allowedTools: ["Read", "Glob", "Grep"], mcps: {},
    model: "sonnet", systemPrompt: "Investigate issues and report your findings.", maxTurns: 24,
  }),
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
});
```

Run `cantelop dev --container` from this directory. The image ships the pinned CLI and its private sign-in PTY helper; sign in through `app.workspace(selector).auth()` before submitting input. See [native auth](../../docs/native-auth.md). App secrets and provider credentials remain Workspace scoped.

## Submit and observe

Use the compiled backend client produced by `cantelop build` or `cantelop deploy`:

```ts
import { app } from "./.cantelop/client/client.mjs";
import { applyClaudeSessionChange } from "@cantelop/sdk/harnesses/claude/protocol";

const session = app.workspace({ slug: "customer" }).session({ id: "investigation" });
const admitted = await session.request({ type: "input", id: "issue-123", text: "Investigate this issue" });
if (admitted.type === "error") throw new Error(admitted.code);

const snapshot = await session.view();
let state = snapshot.state;
render(state);
for await (const event of session.stream({ after: snapshot.cursor })) {
  if (event.data.type === "session.changed") {
    state = applyClaudeSessionChange(state, event.data);
    render(state);
  }
}
```

`request()` returns an `input.status` admission/delivery reply, not the model's final answer. `dispatch()` returns platform admission earlier; the first view may not exist until runtime intake commits it. Reuse the same input `id` and payload for retries. Changed text or settings with that ID return `message_id_conflict`.

`{type:"steer",id,text}` has the same native input behavior. Busy inputs enter the active run; they do not wait for a separate follow-up job. Each native input has a persisted UUID, and only an echoed input becomes `running`. A native result settles the inputs consumed in that turn. Inputs arriving while cleanup is in progress return `run_finishing` before admission.

The platform snapshot's `revision` and `cursor` belong to its view service. `snapshot.state.revision` belongs to the Claude adapter; the reducer uses it to ignore duplicated publication after a crash. When the platform cursor expires, fetch a fresh `view()` and subscribe from its cursor. Ending a subscription does not cancel execution.

The view contains the recent conversation, input states, the current/latest run, tool observations and latest reported usage. It stays under 48 KiB within the platform's 64 KiB frame limit. Input previews are capped at 1 KiB; entry text is capped at 8 KiB. `truncated` explicitly indicates incomplete history. State retains at most 1,000 input identities and 256 recent entries; after input capacity is exhausted, start another Session. This API does not expose an unlimited transcript archive.

Raw native observations remain available as `claude` and `claude.fragment` events. Their `id` is the run ID, and `revision` identifies their durable adapter transition. `ClaudeSessionOutput(runId)` reconstructs fragments. Consumers of raw output must deduplicate replayed revisions themselves; the view reducer already does so.

## Settings and cancellation

An idle input may override `tools`, `allowedTools`, `mcps`, `model`, `systemPrompt` and `maxTurns`. Lists and MCP maps replace defaults. A busy input inherits the active run's accepted settings; incompatible overrides return `active_settings_conflict`. Settings remain immutable until that run finishes. Completed runs release their private MCP settings, which never enter the public view.

`session.cancel()` cancels the active managed activity. A targeted runtime request, `session.request({type:"cancel",id:"issue-123"})`, cancels that input's active run, including other inputs steering the same run. Neither operation rolls back tool effects. Cancellation receipts acknowledge a request; the view records the outcome after cleanup. Reuse the platform command ID when retrying cancellation or reset so it cannot affect a later run.

## Persistence and recovery

The runtime writes a versioned private state file at `/workspace/.cantelop/<hashed-session-id>.json`. It synchronizes temporary file contents before atomic rename and synchronizes the containing directory. State transitions and pending publication are committed together. Publication sends the revisioned change before committing its platform view/cursor; acknowledged outbox records are then removed. Replacement retries the same logical changes, and the client reducer ignores duplicates.

Claude owns the native transcript under `/workspace/.claude`. Native `init` is not proof of a durable checkpoint. On the next run, the adapter checks for a candidate transcript and lets Claude validate resume. Missing candidates produce `native_resume_unavailable`; other native failures remain explicit failures. The runtime never repairs or edits private transcript formats.

On activation, input that was never attempted can be delivered. Attempted input whose outcome was not recorded becomes `interrupted`; it is not automatically resubmitted. The next explicit input can resume the preserved conversation. If no usable checkpoint exists, `session.request({type:"reset"})` explicitly starts a fresh native conversation while retaining the adapter's observed history. Reset requires idle execution.

Workspace durability and exclusive ownership during Sandbox replacement are platform guarantees. Local process tests do not establish NFS/JuiceFS host-failure durability or qualify a deployed platform release. Arbitrary tool replay and native background-agent recovery are outside this runtime's guarantee.

## Migration and lower-level harness

Previous `createClaudeRuntime` versions accepted `{type:"queue",...}`. Replace those calls with `{type:"input",...}` only where native steering is intended. Old queue commands now return `unsupported_command`; old pending/running state migrates to explicit interruption and never silently executes as steering. Submit intentional replacement work with a new input ID. The old `snapshot` request now returns `{type:"session.state",state:ClaudeSessionView}`. Use the fourth App generic above to type `.view()`.

Existing applications using `runtime: {create:createClaudeHarness}` or `NativeClaude` keep their one-shot CLI behavior and process-local ordering. That lower-level API remains available for application-owned orchestration. Its `steer` interrupts and resumes a CLI process; it does not provide this runtime's native streaming input or durable view.

For a custom image, install the same pinned CLI and `/opt/app/login-pty.py`, set the App's `dockerfile` to your image's Dockerfile, and optionally declare `CLAUDE_PATH` and `CLAUDE_MODEL` environment settings. The SDK-provided Dockerfile is self-contained and requires no copied files from this example.

## Qualification

From the SDK repository root, run `pnpm test`, `pnpm check:examples` and `pnpm check:package` for SDK verification. The optional native integration test uses a local mock model endpoint and temporary credentials, with no paid model calls:

```sh
CANTELOP_TEST_CLAUDE_BINARY=/absolute/path/to/pinned/claude \
  node --test test/claude-native-integration.test.mjs
```

Use the version pinned in `assets/claude/Dockerfile`. This test covers real native input acknowledgments, steering, exact conversation resume and view reconstruction through the actor protocol with a simulated platform collector. `test/claude-crash-recovery.test.mjs` kills separate runtime workers before native delivery and during unacknowledged observation publication.
