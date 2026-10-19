# Cantelop SDK

Cantelop runs agents for your application in isolated Sandboxes with durable Workspaces. `@cantelop/sdk` is how your backend talks to them and how you define what runs inside each Session. It includes a packaged Claude Code harness, so a working agent App is one short definition file.

- **App:** a deployed agent, with a name, a Session runtime and its configuration.
- **Workspace:** durable files and a database, typically one per customer or user. Every Session in a Workspace shares them.
- **Session:** one conversation or task. Its Sandbox is released when idle and reactivated by the next message; the Session identity stays reusable.

You define the Session runtime. The SDK generates the App's Edge API, and Cantelop deploys both. Apps use [project schema 3](schemas/app-v3.json).

For a local editor with remote agent execution, [`workspace.sync()`](docs/workspace-sync.md) reconciles a local directory with the Workspace's `project/` folder. Hosted writes remain gated pending storage qualification.

## Get started

You need:

- Node.js 22 or newer
- The Cantelop CLI 0.15.2 or newer: `brew install stepandel/tap/cantelop` (check with `cantelop version`)
- Docker with `linux/amd64` build support
- A Claude subscription (Pro or Max) to sign the agent in
- A Cantelop account, when you deploy

### 1. Define the App

In an empty directory:

```sh
npm init -y
npm pkg set type=module
npm install @cantelop/sdk
```

Add `cantelop.json`, which points the CLI at your App definition:

```json
{ "schema_version": 3, "definition": "src/cantelop.ts" }
```

Add `src/cantelop.ts`:

```ts
import { CantelopClient } from "@cantelop/sdk";
import {
  createClaudeRuntime, claudeAuth, claudeDockerfile,
  type ClaudeSessionCommand, type ClaudeSessionEvent,
  type ClaudeSessionReply, type ClaudeSessionView,
} from "@cantelop/sdk/harnesses/claude";

const cantelop = new CantelopClient();

export const agent = cantelop.app<ClaudeSessionCommand, ClaudeSessionEvent, ClaudeSessionReply, ClaudeSessionView>({
  name: "hello",
  runtime: createClaudeRuntime(),
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
});
```

That is the whole App. `createClaudeRuntime` runs the stock Claude Code CLI, delivers new input into ongoing work, and maintains a durable conversation view. When idle, new input resumes the saved native conversation if its checkpoint is available. `claudeAuth` lets each Workspace sign in with its user's own Claude subscription. `claudeDockerfile` is the SDK-maintained Sandbox image with the CLI installed. `name` is the App's deployment slug.

### 2. Run it locally

```sh
cantelop dev --container
```

This builds the Sandbox image, serves the App at `http://127.0.0.1:8787`, and records a credential in the SDK's `local` profile. The Claude CLI and its sign-in helper live in that image, so use `--container`. Restart it after editing `src/cantelop.ts`.

In a second terminal, compile the backend client. It keeps the App's exports and types but none of its Sandbox code, so a backend can import it:

```sh
node --input-type=module -e 'import { buildBackendClient } from "@cantelop/sdk/build"; await buildBackendClient({ definition: "src/cantelop.ts", outdir: ".cantelop/client" })'
```

`cantelop build` and `cantelop deploy` also write this client. Rebuild it whenever you change the App definition.

### 3. Sign in and send a prompt

Save this backend script as `try.mjs`:

```js
import { createInterface } from "node:readline/promises";
import { agent } from "./.cantelop/client/client.mjs";
import { applyClaudeSessionChange } from "@cantelop/sdk/harnesses/claude/protocol";

const workspace = agent.workspace({ slug: "ada" });

// Sign the Workspace in to Claude once. The credentials stay in the Workspace.
const auth = workspace.auth();
const login = await auth.login();
if (!login.authenticated) {
  console.log(`Sign in to Claude: ${login.url}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const code = await terminal.question("Paste the code: ");
  terminal.close();
  if (!await auth.submitCode({ attemptId: login.attemptId, code })) throw new Error("Sign-in failed");
}

const session = workspace.session();
const id = crypto.randomUUID();
const reply = await session.request({ type: "input", id, text: "Summarize the files in this directory" });
if (reply.type === "error") throw new Error(reply.code);

const snapshot = await session.view();
let state = snapshot.state;
console.log(state);
const finished = () => state.inputs.some(input => input.id === id &&
  ["completed", "failed", "cancelled", "interrupted"].includes(input.status));
if (!finished()) for await (const event of session.stream({ after: snapshot.cursor })) {
  if (event.data.type !== "session.changed") continue;
  state = applyClaudeSessionChange(state, event.data);
  console.log(state);
  if (finished()) break;
}
```

```sh
CANTELOP_PROFILE=local node try.mjs
```

The first run prints a Claude sign-in link. Open it, sign in, and paste the code the page shows. Later runs reuse the Workspace's credentials. Sign a Workspace in before its first prompt: the harness can't run Claude without credentials, and a prompt sent earlier fails without producing output.

`dispatch()` returns once the message is durably admitted, not when the agent finishes. `stream()` relays the agent's events as it works.

### 4. Deploy

```sh
cantelop login
cantelop deploy --create-app
cantelop app credentials --app hello   # backend configuration, in dotenv form
```

`deploy` builds and uploads the App and refreshes `.cantelop/client/`. Store the printed credentials in your backend's secret store; see [App configuration](docs/app-configuration.md). Each user's Workspace then signs in once through the same `login()` and `submitCode()` calls, made from your backend.

Any change to runtime logic or types gives the App a new runtime identity, so rebuild and redeploy your backend whenever you deploy the App; see [deploy the backend with the App](docs/runtime-definitions.md#deploy-the-backend-with-the-app).

## Use the App from your backend

```ts
import { agent } from "./.cantelop/client/client.mjs";

const workspace = agent.workspace({ slug: "customer-123" });
// Or: agent.workspace({ id: canonicalWorkspaceId });
const session = workspace.session({ id: "conversation-456" });

const message = await session.dispatch({ type: "input", id: "issue-123", text: "Investigate this issue" });
const status = await message.status();
```

Backends import the compiled client, or bundle the App definition with the Cantelop compiler plugin, which removes Sandbox-only dependencies. Importing `src/cantelop.ts` untransformed loads the harness and its dependencies. See [runtime compilation](docs/runtime-definitions.md).

`CantelopClient` supplies shared connection context, optionally selecting a profile. Each `cantelop.app({ name, runtime })` declares a named App with its own typed runtime and Workspace namespace. One client can define multiple Apps. App names are deployment slugs, independent of JavaScript export names. Connections and scoped credentials resolve automatically per App; constructing these objects does not provision resources. See [App configuration](docs/app-configuration.md).

Traffic follows `backend → SDK → protocol-managed App Edge Worker → outbound Worker/broker → Session runtime`. All App operations use the versioned `{ protocolVersion, id, workspace, session, command }` envelope, each at its own `POST /commands/{type}` path (`/commands/dispatch`, `/commands/view`, …), so request logs and the Cantelop console show which SDK call each request was. Edge ↔ Sandbox is the independently versioned actor protocol. See [the command and durable view contracts](docs/integration-foundation.md).

Workspace and Session references are lazy. Omitting a Session ID generates one immediately. `dispatch()` lazily resolves/provisions a Workspace slug and activates a Sandbox when needed. A canonical Workspace ID never provisions a replacement. Explicit resolution and database access share the Workspace reference’s cached metadata. Session IDs are App-scoped even though references are nested under Workspace.

Acceptance means durable message admission, not agent completion. Runtimes that declare a reply type, such as `createClaudeRuntime` or a custom harness, also support `session.request(message, { timeoutMs })`, which waits for one JSON reply. Timeout or disconnect ends waiting and does not prove execution stopped. A failed request exposes its Message ID through `RemoteAppError`; reuse that ID for an ambiguous retry. The SDK does not automatically replay writes.

## Steer, cancel and stop

```ts
await session.steer({ type: "steer", id: "focus-auth", text: "Focus on the authentication module" });
await session.cancel(); // { state: "requested" | "idle" }
await session.stop();   // release the Sandbox; the Session identity stays reusable
```

Dispatch and steer accept the same message type and return an ID/status reference. Both accept optional `{ id, keepAliveSeconds, signal }`. Keep-alive falls back from method options to the Session reference to the configured App default. The durable Claude runtime starts input while idle and steers ongoing work while busy. Factory runtimes delegate dispatch to the harness's `queue` method and steer to its `steer` method; those harnesses define their own input policy.

`session.cancel({ id?, signal? })` takes no target message ID. It signals the active managed activity or delegates to a factory harness's `cancel()` method. `requested` acknowledges interruption, not completed cleanup; execution remains owned until cleanup settles. Cancellation while idle does not affect later input. Retrying the same platform command ID reuses its result and cannot interrupt a subsequent run.

Submission IDs serve receipts, retries and output correlation. Message status describes intake, so active work can outlive its message's `handled` status.

`stop()` releases the current Sandbox and closes streams, potentially interrupting work. The next message activates the same Session on a new Sandbox. Workspaces keep durable files and databases; Session memory, harness memory and temporary files belong to one Sandbox incarnation. Multiple Sessions may share a Workspace, so the application owns coordination of shared state.

## Stream output

```ts
for await (const event of session.stream({ signal })) {
  console.log(event.data, event.cursor, event.messageId);
}
```

`stream()` is an async iterator over the Session's SSE output. Metadata includes cursor `{ streamId, sequence }`, Session ID, Message ID, and creation time. Resume explicitly with `session.stream({ after: savedCursor })`. Replay is bounded; cursor expiration and stream reset keep their remote error codes. The SDK does not reconnect automatically.

Breaking iteration or aborting the subscription only closes its stream. It does not cancel agent work or keep the Sandbox warm. Browser-facing routes remain part of the application's own authorized backend.

The Claude harness emits Claude Code's native `stream-json` objects. Frames over 48 KiB arrive as `native.fragment` events; concatenate their `json` in `index` order and parse the result.

## Sign Workspaces in

Apps that declare `auth` let each Workspace sign in to a stock CLI with the user's own subscription. Native credentials stay in the Workspace, so every Session there shares them. Use auth only on Workspaces that belong to a single verified user, and derive the selector from that user's identity.

`app.workspace(selector).auth()` exposes the sign-in methods. For a provider with a `codeLogin` adapter, such as `claudeAuth`, `login()` returns `{authenticated:true}` or `{authenticated:false,attemptId,url,expiresAt}`. `submitCode({attemptId,code})` returns native authentication status or a stable `code_rejected` error, and `cancelLogin({attemptId})` stops that attempt. `login({force:true})` confirms native logout before starting a fresh login. The SDK owns attempts, prompt parsing, bounded private output, expiration and process cleanup. Application authorization and account preferences stay on your backend.

Low-level `terminal()`/`close()` serve integrations that intentionally expose the CLI's own terminal. Hosted Cantelop does not yet relay that terminal to browsers. See [native auth](docs/native-auth.md).

## Configure the Claude harness

Pass options to choose the model, tools, prompt and limits for each Session:

```ts
export const agent = cantelop.app<ClaudeMessage, ClaudeEvent>({
  name: "hello",
  runtime: {
    create: (context) => createClaudeHarness(context, {
      model: "sonnet",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Grep", "Glob"],
      systemPrompt: "Investigate issues and report your findings.",
      maxTurns: 24,
    }),
  },
  auth: claudeAuth,
  dockerfile: claudeDockerfile,
});
```

Options also cover `tools`, `settingSources`, `mcps` and a `conversation` seed. They are snapshotted when the factory runs; the SDK context supplies the canonical Session identity. Without options, the harness keeps the CLI's native configuration, with `CLAUDE_MODEL` and `CLAUDE_PATH` read from the App's declared environment.

`createClaudeRuntime(options)` provides native streaming input and durable observations. `{type:"input",id,text}` starts a run while idle and steers the same run while busy; `{type:"steer",...}` has the same native behavior. Accepted inputs, attempted delivery, native observations and outcomes are persisted before publication. `session.view()` returns the committed projection; `applyClaudeSessionChange` applies subsequent `session.changed` events idempotently. There is no follow-up queue. Settings can change between runs; incompatible changes during a run return `active_settings_conflict`. Its protocol types are in `@cantelop/sdk/harnesses/claude/protocol`. The [Claude Code example](examples/anthropic/README.md) covers both, plus custom images and `NativeClaude` for custom construction.

## Other runtimes

Stock CLI harnesses for [Codex](examples/codex/README.md) and [OpenCode](examples/opencode/README.md) follow the same pattern as the Claude harness, as examples rather than packaged exports. [Pi](examples/pi/README.md) and [OpenAI Agents](examples/openai/README.md) show framework integrations.

To write your own, return a harness from `runtime.create`:

```ts
// src/agent.ts — the harness factory compiled into the Sandbox.
import type { SessionHarness, SessionHarnessContext } from "@cantelop/sdk/session";
import type { Message, Event, Reply } from "./contracts.js";
import { createHarness } from "./harness.js";

export function create(context: SessionHarnessContext): SessionHarness<Message, Event, Reply> {
  return createHarness(context); // Implements queue(message, work), steer(message, work), cancel().
}
```

The factory runs once per Session runtime incarnation, on the first harness command or recovery. It returns one harness implementing `queue(message, work)`, `steer(message, work)`, and `cancel()`. Each implementation owns ordering, steering behavior, interruption, and cleanup. The SDK calls those methods directly and keeps intake responsive while their promises remain pending. `queue` resolves after the submitted operation and its cleanup; its return value supplies `session.request()` replies. `steer` resolves at the implementation's completion boundary: native input may be accepted immediately, while an interrupt-and-resume implementation can wait for the redirected turn.

Work receives a signal, typed output/view, submission identity and Session resources. The SDK tracks operation lifetimes, attribution and deadlines without selecting provider scheduling behavior. `cancel()` returns whether an active operation was signalled and preserves waiting input. The compiler bundles the factory and its dependencies into the Sandbox while excluding them from backend and Edge artifacts.

Custom runtimes can instead use `runtime: { receive, onActivate?, onRecover?, redelivery? }`. Their intake is serialized; move long-running work into `context.activity` with `activity.start`, `queue`, `steer`, and `cancel`, and register provider methods through activity options `onSteer` and `onCancel`.

Applications own durable jobs, checkpoints, and idempotency. The optional `onActivate` hook restores state once per incarnation; the optional `onRecover` hook opts into replacement-Sandbox recovery. Redelivery is opt-in for deduplicating intake handlers. Successful `receive` acknowledges application intake; it does not mean a durable job has completed. Persist state under `/workspace` or in the Workspace database. Output/replies keep their JSON and size limits.

Runtimes that don't need a custom image can run locally without `--container`: plain `cantelop dev` runs Sessions natively with Bun 1.3.10 and rebuilds as you edit.

## Durable Session views

The SDK commits projections through the platform's durable view service. Reading the last committed view does not activate a Sandbox.

The runtime explicitly commits the application's read model:

```ts
async function receive(context: SessionContext<Message, Event, Reply, State>) {
  const state = await updateApplicationState(context.message.payload);
  await context.view.commit(state);
  context.reply(state);
}
```

`view.commit` resolves after the platform stores the projection and its atomic event boundary. Customer code owns application state and recovery; committing a view does not replace the application's database or replay its runtime closures.

```ts
const snapshot = await session.view();
render(snapshot.state);
for await (const event of session.stream({ after: snapshot.cursor })) {
  apply(event.data);
}
```

Supervised activity can also call its own `view.commit(state)` capability while it is active. This capability follows the activity signal and closes when that activity settles.

A view read never opens a Workspace or activates a Sandbox. A missing projection returns `session_view_not_found`. Views survive stop and host restart; stream resume is subject to the platform's bounded replay retention. Projection commits advance the stream cursor without appearing as application events.

## Examples

- [Claude Code](examples/anthropic/README.md): the packaged harness, link/code sign-in and the durable `createClaudeRuntime` lifecycle.
- [Web chat](examples/web-chat/README.md): a browser → application backend → `CantelopClient` integration.
- [GitHub issue agent](examples/github/README.md): an App webhook that verifies signed deliveries and dispatches through the same App interface.
- [Multi-App](examples/multi-app/README.md): two Apps under one client.
- [All examples](examples/README.md), including Codex, OpenCode, Pi and OpenAI Agents.

[Workspace databases](docs/workspace-databases.md) covers renewal, transactions and schema migrations.

## Develop the SDK

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm check:examples
pnpm check:package
pnpm test:bun
```

Package qualification checks the actual npm tarball and its packed files, generated Edge and native runtime build artifacts, and a clean consumer's integration types. Publishing is a separate operation; see [release guidance](docs/releasing.md).
