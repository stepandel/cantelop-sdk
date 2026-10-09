# Agent chat in a web app

A browser chat UI and an application-owned Node HTTP server demonstrate how to integrate `CantelopClient` into an existing app. This project owns its [client definition](src/cantelop.ts), [OpenAI Session behaviour](src/agent.ts), shared contracts, and `cantelop.json`. The backend and Sandbox use the same definition; no customer Edge routes are authored.

```text
Browser → POST /api/chat → CantelopClient → App Edge /commands → agent runtime
Browser ← streamed chat text ← session.stream()
```

The files follow the application flow:

- `src/cantelop.ts` configures the client and delegates incoming messages to the agent.
- `src/agent.ts` implements the OpenAI agent.
- `src/contracts.ts` defines the shared message and output types.
- `src/server.ts` serves the chat UI and handles browser requests.
- `public/` contains the browser assets.

The integration is in [src/server.ts](src/server.ts):

```ts
import { cantelop } from "./cantelop.js";
const workspace = cantelop.workspace({ slug: "web-chat-demo" });
const session = workspace.session({ id: conversationId, keepAliveSeconds: 300 });
const message = await session.dispatch(
  { type: "prompt", prompt },
  { id: submissionId, signal },
);
for await (const event of session.stream({ signal })) {
  if (event.messageId === message.id) {
    // Forward this turn's text_delta/done events to the browser.
  }
}
```

## Run

This SDK alpha requires the coordinated CLI/platform rollout: schema 3, build protocol 6, App integration credentials, integration-v2 commands and retained event replay. Current production CLI/platform deployments cannot run this protocol yet. The web server and UI run locally now; live agent responses require a compatible App Edge deployment. The automated tests qualify the HTTP → real SDK → controlled Edge response flow, rather than a live deployment.

1. From the SDK root, run `pnpm install` and `pnpm build`.
2. Deploy/configure this web-chat App with a compatible CLI/platform and supply `OPENAI_API_KEY` in its runtime environment.
3. Configure this backend with that App's integration profile or App-scoped environment configuration. See [App configuration](../../docs/app-configuration.md). For environment configuration, supply `CANTELOP_APP_SLUG` and `CANTELOP_INTEGRATION_TOKEN`; use `CANTELOP_EDGE_URL` for a local Edge origin override. These are backend configuration, never browser variables.
4. Run `pnpm --filter @cantelop/example-web-chat dev`.
5. Open `http://127.0.0.1:3000` and send a message. `PORT` changes the web server port; `CHAT_WORKSPACE_SLUG` changes its server-owned Workspace (default `web-chat-demo`).

No `.env` loader is installed; export configuration in the process environment or use the integration profile. Run `pnpm check:examples` to check all examples and `pnpm test` to run the SDK and web HTTP integration tests.

## How it works

The backend imports the configured client and chooses one Workspace. The browser generates an App-scoped Session ID and retains it in `sessionStorage`, so subsequent turns use the same warm agent conversation. New chat generates a fresh Session ID. The browser transcript is local UI state; it is not a durable history/view implementation and is not restored on reload. This runtime’s MemorySession survives only its warm runtime incarnation.

Each POST includes a fresh message ID. The server passes it to dispatch, then returns newline-delimited JSON for admission, text deltas, the final answer or an error. It filters output by the admitted message ID, so replayed output from earlier turns is excluded. The Edge stream must replay retained events from the start when no cursor is supplied, including output emitted between admission and subscription. Cursor expiry/reset and stream failures surface as errors; the example never silently reconnects or submits the prompt again.

The composer permits one turn at a time. The server closes its subscription after `done`, after two minutes, or when the browser disconnects. Disconnecting does not cancel admitted work or release the Sandbox; the UI says work may continue. A failure after submission can have an unknown outcome. The application does not automatically retry. After disconnecting, a fresh conversation avoids queueing a new turn behind unfinished work; attribution of queued runtime follow-ups remains part of the coordinated runtime contract.

The web server binds to loopback and serves a single-user example. In an existing authenticated app, choose the Workspace from the authenticated tenant and authorize the conversation against that tenant in your own route. The browser does not supply Workspace/App selectors. Integration/provider credentials remain on the backend/runtime, and user/agent output is rendered as text.

`/api/chat` is this customer's HTTP endpoint. `/commands` is the protocol-managed agent App endpoint reached by `CantelopClient`. This is the same pattern an app-owned webhook handler or job would use.
