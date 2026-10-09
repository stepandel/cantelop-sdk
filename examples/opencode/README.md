# OpenCode agent integration

`src/session.ts` defines the provider integration in the native Session runtime. `src/client.ts` exports `agentSession()` for calls from an existing application backend. There is no customer Edge API, router, or HTTP request contract.

```ts
const session = agentSession(connection, { slug: "customer-123" }, {
  id: "conversation-456",
  keepAliveSeconds: 300,
});
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  if (event.data.type === "text_delta") console.log(event.data.delta);
}
```

Use an App-bound connection supplied by a compatible platform/local CLI adapter. This prerelease requires CLI build protocol 6 and runtime-only manifest schema 3; the existing CLI cannot deploy it yet. Provider configuration is declared in `cantelop.json`; keep provider credentials in the runtime environment.

The runtime still handles its application-defined `prompt`, `steer`, and `cancel` messages. Until named runtime capabilities are implemented, send those custom commands through `dispatch()`. Protocol-level `session.steer(message)` submits the same payload with actor priority; `session.cancel(messageId)` targets one submission. Both require the coordinated platform/runtime follow-up; these examples do not advertise those capabilities yet.

OpenCode requires the custom image declared in `cantelop.json`. The Dockerfile installs the headless server; Cantelop owns startup and Workspace mounts. Its server conversation state lasts for the warm Sandbox lifetime.

Run `pnpm check:examples` from the SDK root to type-check the backend client and runtime and qualify the runtime-only build artifact.

## Image and runtime behavior

The SDK and OpenCode binary are pinned to 1.18.30; update them together. The custom image installs Node.js, Git, ripgrep, and the executable. Cantelop supplies Bun, startup, and the `/workspace` working directory. Configure `ANTHROPIC_API_KEY`; `OPENCODE_MODEL` defaults to `anthropic/claude-sonnet-4-5`. Another provider requires updating both the credential declaration and runtime credential check.

Each managed activity starts a localhost-only headless server, connects to its events before submitting work, filters output by conversation and assistant message, and closes the server on completion. Busy application steering queues a follow-up turn rather than interrupting a current tool/model call. Application `cancel` clears pending prompts, aborts the activity/provider, and closes the server; it does not undo completed file edits.

Workspace files persist, but conversation history is not restored after Sandbox replacement. OpenCode's live database remains in managed ephemeral home. `keepAliveSeconds: 0` can lose continuity between requests; durable conversation restore needs a separate persistence design.

This unattended coding example allows tools by default while denying external-directory access, interactive questions, and doom-loop permission requests. Review the runtime's permission configuration and use trusted Workspaces. The example emits text and errors rather than tool traces or interactive approvals. The application backend owns caller authorization before exposing any client-facing route.
