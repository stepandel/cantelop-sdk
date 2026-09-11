# OpenCode Session runtime example

Runs the OpenCode coding harness inside a Cantelop Sandbox. The Edge API imports
no provider code; `src/session.ts` starts a localhost-only headless server and
controls it with `@opencode-ai/sdk/v2`. Both the SDK and the image's OpenCode binary
are pinned to 1.18.30. Update them together.

## Setup

From the repository root:

```sh
pnpm install
pnpm check:examples
```

Copy `.env.example` to `.env` in this directory and supply your Anthropic API key.
The default model is `anthropic/claude-sonnet-4-5`; change `OPENCODE_MODEL` to a
model available to your account. To use another provider, also change the required
credential in `cantelop.json` and the credential check in `src/session.ts`.

From this directory, use the Cantelop CLI:

```sh
cantelop deploy --dry-run
cantelop deploy --create-app
```

Production requires the `ANTHROPIC_API_KEY` App secret. Change the illustrative
`app` slug in `cantelop.json` as needed. The custom Dockerfile installs OpenCode,
Node.js, Git, and ripgrep. Cantelop supplies Bun, the startup command, and the
`/workspace` working directory. Add other build tools to the image if your agent
needs them. The OpenCode executable is installed in the image, not bundled into
the Session JavaScript.

## HTTP protocol

The routes match the [shared example guide](../README.md):

- `GET /health`: reports the `opencode` runtime.
- `POST /chat`: takes `workspaceSlug`, `keepAliveSeconds`, `prompt`, and an optional
  `sessionId`. Returns the Session ID and accepted message reference (`202`).
- `POST /steer`: takes the same fields with a required `sessionId`. When busy,
  this queues a follow-up turn; it does not interrupt the active model/tool call.
- `POST /cancel`: takes `sessionId`, `workspaceSlug`, and `keepAliveSeconds`.
  Clears pending prompts, aborts the activity, calls OpenCode's abort endpoint,
  and closes the server. Cancellation does not undo completed file edits.
- `GET /events`: takes those three Session coordinates as query parameters and
  streams `text_delta`, `done` (with `answer`), or `error` (with `message`) over
  SSE or the `cantelop.events.v1` WebSocket subprotocol.

Open the event subscription before sending a prompt. Example request:

```sh
curl -X POST "$APP_URL/chat" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"coding-1","workspaceSlug":"project-1","keepAliveSeconds":300,"prompt":"Inspect the workspace and summarize what is here."}'
```

Prompts run in a managed activity so the mailbox remains available for cancel
and follow-up requests. The adapter waits for OpenCode's event connection before
submitting work, filters text by conversation and assistant message, and keeps
the activity alive until completion. Each activity starts and closes its own
server. OpenCode's local database and the in-memory conversation ID provide
conversation continuity between turns while the same Sandbox remains alive.

## Lifetime and tool permissions

Workspace files persist, but conversation history is **not restored after a
Sandbox replacement**. `keepAliveSeconds: 0` can therefore lose conversation
continuity between requests. OpenCode data stays in the managed ephemeral home;
the example does not relocate its live database onto the NFS-backed Workspace.
Durable conversation restore needs a separate persistence design.

This is an unattended coding example: tools are allowed by default, with
external-directory access, interactive questions, and doom-loop permission
requests denied. Review the `permission` configuration for your application.
The example forwards text and errors, not tool traces or interactive approvals.
OpenCode loads project configuration from the working directory; use trusted
workspaces. As with the other examples, add caller authentication and Session
access checks before exposing the HTTP API publicly.

References: [OpenCode SDK](https://opencode.ai/docs/sdk/) and
[headless server](https://opencode.ai/docs/server/).
