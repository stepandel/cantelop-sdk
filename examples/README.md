# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/session.ts  Linux-native Session logic
cantelop.json   Build and deployment manifest
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, and routes. Provider SDKs, credentials, and
incremental events remain confined to the native Session logic entrypoint. Cantelop injects
the current App into each API definition. Every API exposes four routes:
`GET /health`, `POST /chat`, `POST /steer`, and `POST /cancel`. Chat creates or
reuses a Session from an optional ID; steer and cancel require an existing
Session ID. All message routes call the same asynchronous
`dispatch()` method, and return an in-memory acceptance receipt with status
`202`. Each example defines an explicit `SessionMessage` protocol with
`prompt`, `steer`, and `cancel` commands, plus a `SessionEvent` stream for text
deltas and completion. A steer received while idle starts a provider turn. New
prompts received while busy enter a per-Session FIFO queue. OpenAI and Anthropic
also queue active steer commands because their active runs are not steerable;
Pi applies active steer directly to its Agent. All three propagate cancel
through the Session activity's `AbortSignal` and clear queued prompts. The
Session identity is propagated into the native harness, and direct client
streaming is configured at the VM.

Each manifest targets an illustrative App slug. Create that App or change its
`app` value before running `cantelop deploy`; generated App IDs are never stored
in the example source.

Run all API and harness type checks plus deployment bundle smoke checks from
the repository root:

```bash
pnpm check:examples
```
