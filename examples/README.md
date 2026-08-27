# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/session.ts  Linux-native Session behaviour
cantelop.json   Build and deployment manifest
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, and routes. Provider SDKs, credentials, and
incremental events remain confined to the native Session behaviour entrypoint. Cantelop injects
the current App into each API definition. Every API exposes four routes:
`GET /health`, `POST /chat`, `POST /steer`, and `POST /cancel`. Chat creates or
reuses a Session from an optional ID; steer and cancel require an existing
Session ID. All message routes call the same asynchronous
`dispatch()` method and return an accepted message reference with HTTP status
`202`. Each example defines an explicit `SessionMessage` protocol with
`prompt`, `steer`, and `cancel` commands, plus a `SessionEvent` stream for text
deltas and completion. A steer received while idle starts a provider turn.
OpenAI keeps busy-time prompts in a per-Session FIFO because a text `run()`
cannot accept more input. Anthropic feeds prompts and prioritized steer commands
into its live `SDKUserMessage` stream. Pi applies active steer directly to its
Agent and keeps ordinary busy-time prompts in a Cantelop FIFO. All three
propagate cancel through the Session activity's `AbortSignal`. The Session
identity is propagated into the native Session runtime, and direct client streaming is
configured at the VM.

Each manifest targets an illustrative App slug. Create that App or change its
`app` value before running `cantelop deploy`; generated App IDs are never stored
in the example source.

Run all API and Session runtime type checks plus deployment bundle smoke checks from
the repository root:

```bash
pnpm check:examples
```
