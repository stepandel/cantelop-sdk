# Native CLI authentication

Some harnesses wrap a stock CLI that signs in with the user's own subscription, for example Claude Code with a Claude Pro or Max plan. Cantelop supports this by giving the user the CLI's **own terminal**. The user completes the CLI's sign-in there, and the CLI stores its credentials in the Workspace.

No part of the App ever handles the sign-in code or the resulting credentials: not the App backend, not the Edge, not Cantelop's delivery records. The SDK relays terminal bytes in memory and nothing else. It does not parse, log, store or replay them. This follows Anthropic's [Claude Code terms](https://code.claude.com/docs/en/legal-and-compliance), which allow an end user to sign in to the unmodified binary on a hosting platform. The same terms forbid third parties from collecting, storing or intermediating Claude.ai credentials or session tokens.

## Declare auth on the App

```ts
import { claudeAuth } from "./auth.js";

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "anthropic",
  runtime: { create },
  auth: claudeAuth,
});
```

`auth` is an `AppAuth` provider:

```ts
interface AppAuth {
  status(context: AuthContext): boolean | Promise<boolean>;
  logout(context: AuthContext): void | Promise<void>;
  /** Spawn the CLI's interactive login, usually through a PTY. Return the process right after spawning it. */
  terminal(context: AuthContext): AuthTerminalProcess | Promise<AuthTerminalProcess>;
}
```

`AuthContext` supplies `signal`, `session` and the App's `env`.
- **Process requirements.** The returned process needs `stdin`, `stdout`, `kill()` and a `close` event. A `ChildProcess` qualifies.
- **Resizing.** An optional `resize(columns, rows)` lets the user's terminal resize the PTY.
- **Where it runs.** The compiler bundles `auth` into the Sandbox runtime only. Backend and Edge builds keep a marker, so `node:child_process` and the provider's other dependencies never reach them.
- **What Cantelop calls.** Only these three functions, and only in the Workspace's auth Sandbox. That Sandbox never creates a harness.

The provider is App-level, so it works with both `create` and `receive` runtimes.

## Backend

```ts
const auth = app.workspace({ slug: user.workspaceSlug }).auth();
if (!await auth.status()) {
  const terminal = await auth.terminal();
  // Send { url, protocols } to the signed-in user's browser unchanged.
  return Response.json({ url: terminal.url, protocols: terminal.protocols });
}
```

The methods are `status`, `terminal`, `close({ terminalId })` and `logout`. Each one takes an optional `{ id, signal }`. `{ id }` keeps a stable command ID across retries.

`app.workspace(...).auth()` throws if the App doesn't declare `auth`. The Edge also rejects auth commands for such Apps with `auth_not_configured`.

**Workspace ownership.** A subscription sign-in belongs to one person. Use auth only on Workspaces that belong to a single verified user, and derive the selector from that user's identity. Sharing one signed-in Workspace among several people would route their usage through one person's plan.

## Browser

`terminal.url` is a `wss:` URL on the App Edge. `terminal.protocols` carries the single-use ticket as a WebSocket subprotocol, so it never appears in a URL. Example with [xterm.js](https://xtermjs.org):

```js
const { url, protocols } = await (await fetch("/api/claude/sign-in", { method: "POST" })).json();
const term = new Terminal();
term.open(element);
const socket = new WebSocket(url, protocols);
socket.binaryType = "arraybuffer";
const resize = () => socket.send(JSON.stringify({ type: "resize", columns: term.cols, rows: term.rows }));
socket.onopen = resize;
term.onResize(resize);
socket.onmessage = event => term.write(new Uint8Array(event.data));
term.onData(data => socket.send(new TextEncoder().encode(data)));
socket.onclose = () => refreshSignInStatus(); // ask your backend for auth.status()
```

The socket carries two kinds of message:
- **Binary messages** are raw terminal bytes, in both directions.
- **Text messages** are JSON control messages. Only `{ "type": "resize", "columns", "rows" }` exists.

The socket closes when the CLI exits. After that, ask `status()` whether sign-in succeeded.

## Lifecycle

- **One login at a time.** Each Workspace has at most one login. A new `terminal()` call ends the previous one.
- **Connect window.** The browser must connect within 60 seconds (`expiresAt`).
- **Single-use ticket.** Each ticket can connect once.
- **Time limit.** A login ends after 10 minutes.
- **Ending a login.** Closing the browser socket, calling `close({ terminalId })`, or calling `logout()` ends an unfinished login.
- **Keeping the Sandbox alive.** The auth Sandbox stays non-quiescent while a login is running.
- **Pre-connect output.** Output printed before the browser connects is kept in memory, up to 64 KiB, and delivered once it connects.
- **Credentials.** They stay with the native CLI in the persistent Workspace, so agent Sessions in the same Workspace share them.

Three examples include providers. Each runs the stock CLI under a small PTY helper with resize support (`runtime/login-pty.py`, via `examples/native-harness/login.ts`):

| Example | Login | Status / logout |
|---|---|---|
| Claude Code (`claudeAuth`) | `claude auth login`, with every sign-in method the CLI offers | `claude auth status` / `claude auth logout` |
| Codex (`codexAuth`) | `codex login --device-auth`: the user enters a one-time code on OpenAI's page and the CLI finishes by itself | `codex login status` / `codex logout` |
| OpenCode (`opencodeAuth`) | `opencode auth login --provider <id>`, pinned to an allowlisted provider (never Anthropic) | credential entry present / `opencode auth logout <id>` |

Each provider has its own terms for hosted sign-in. Confirm them before offering a provider to users.

## Protocol

**Backend → Edge.** Auth uses the ordinary `/commands` route. It sends `{ type: "auth", auth }` to the reserved Session `cantelop-native-auth`, where `auth` is one of:
- `status`
- `logout`
- `terminal`
- `close` (with `terminalId`)

For `terminal`, the reply carries `terminalId`, `ticket` and `expiresAt`. The Edge adds `url` before returning it.

**Browser → Edge.** The browser opens `GET /__cantelop/auth/workspaces/{workspaceId}/terminals/{terminalId}` as a WebSocket upgrade. This route has no integration token; the ticket authenticates it.
- The Edge forwards only `Upgrade`, `Connection`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version` and `Sec-WebSocket-Protocol`.
- It sends them to `/__cantelop/integration/v2/sessions/cantelop-native-auth/auth/terminals/{terminalId}?workspace_id=…`.
- Cookies and authorization headers are dropped.

**Platform → Sandbox.** The platform terminates the browser's WebSocket and speaks HTTP to the Workspace's running auth Sandbox. Every call carries the ticket in `X-Cantelop-Terminal-Ticket`, alongside the usual `X-Cantelop-Sandbox-ID`. All routes are `POST /__cantelop/v2/runtime/auth/terminals/{terminalId}/…`:

| Route | Body | Response |
|---|---|---|
| `attach` | none | `200` streaming `application/octet-stream` of terminal output. It ends when the CLI exits. Closing it ends the login. It works once per ticket. |
| `input` | raw bytes, up to 64 KiB | `204` |
| `resize` | `{ "columns", "rows" }` | `204` |

**Platform requirements:**
- Echo `cantelop-terminal.v1` as the accepted subprotocol.
- Never log, persist or replay terminal bytes or the ticket.
- Route only to an existing auth Sandbox. A cold Sandbox has no login.
- Close the browser socket when `attach` ends.

`bridgeAuthTerminal(request, socket, head, terminalId, { fetch })` in `@cantelop/sdk/build` is a reference implementation for Node, for example for the CLI's local platform.

**Manifests.** Build manifests mark Apps that declare auth: the Edge manifest gets `auth: true`, and the runtime manifest gets `capabilities.authTerminal: true`.

## Structured link/code login

The packaged Claude provider declares a `codeLogin` adapter, allowing an existing
link-and-code form to use SDK methods instead of exposing the CLI terminal.
`workspace.auth().login({force,signal})` returns native authentication state or a
link, `lgn_` attempt ID and expiry. Submit a code with `submitCode({attemptId,code,signal})`;
handle the stable `code_rejected` error by keeping the form open for retry.
`cancelLogin({attemptId,signal})` cancels only that attempt. Forced login confirms
logout first, so stale credentials cannot satisfy reconnect confirmation.

The SDK owns launch, prompt readiness, bounded output parsing, ten-minute expiry,
code retries and process cleanup. CLI output stays private and credentials stay in
the Workspace. The application backend authorizes the Workspace and relays the
short-lived code without logging or persisting it. Providers without a `codeLogin`
adapter retain their low-level terminal flow; structured login rejects with
`code_login_not_supported`.
