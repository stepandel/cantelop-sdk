# Pi agent integration

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

The runtime still handles its application-defined `prompt`, `steer`, and `cancel` messages. Until named runtime capabilities are implemented, send those custom commands through `dispatch()`. Protocol-level `session.steer()` and `session.abort()` require the coordinated platform/runtime follow-up and must not be silently translated into these messages.

Run `pnpm check:examples` from the SDK root to type-check the backend client and runtime and qualify the runtime-only build artifact.

## Runtime behavior

A prompt received while busy enters the application FIFO queue; active application steering enters Pi's native steering queue. `cancel` aborts the run and clears both queues. `PI_PROVIDER` and `PI_MODEL` select the model; the manifest defaults to Anthropic and `claude-sonnet-5`. Selecting another provider also requires changing the credential declaration.
