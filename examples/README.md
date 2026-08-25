# Provider examples

The OpenAI, Anthropic, and Pi examples each contain two deployment artifacts:

```text
src/api.ts      Edge HTTP middleware
src/harness.ts  Linux-native agent runtime
cantelop.json   Build and deployment manifest
```

Each provider directory is a complete, self-contained implementation with its
own contracts, request validation, and routes. Provider SDKs, credentials, and
incremental events remain confined to the harness entrypoint. Cantelop injects
the current App into each API definition. Every API exposes four routes:
`GET /health`, `POST /chat`, `POST /steer`, and `POST /cancel`. Chat creates or
reuses a Session from an optional ID; steer and cancel require an existing
Session ID. All message routes call the same asynchronous
`dispatch()` method, and return an in-memory acceptance receipt with status
`202`. The protocol does not define steering or cancellation semantics. OpenAI
and Anthropic queue steer prompts as later provider turns; Pi applies steer to
its active Agent. All three propagate cancel through a runtime-managed task's
`AbortSignal`. The canonical Session is propagated into the native harness,
and direct client streaming is configured at the VM.

Each manifest targets an illustrative App slug. Create that App or change its
`app` value before running `cantelop deploy`; generated App IDs are never stored
in the example source.

Run all API and harness type checks plus deployment bundle smoke checks from
the repository root:

```bash
pnpm check:examples
```
