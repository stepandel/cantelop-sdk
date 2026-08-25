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
the current App into each API definition. Every API exposes exactly three
routes: `GET /health`, `POST /chat`, and `POST /steer`. Chat creates or reuses a
Session from an optional ID; steer requires an existing Session ID. Both
routes encode their intent in application messages, call the same asynchronous
`dispatch()` method, and return an in-memory acceptance receipt with status
`202`. The protocol does not define steering, and the FIFO mailbox processes a
steer message only after earlier handlers settle. The canonical Session is
propagated into the native harness:
OpenAI reuses an in-memory conversation store, Anthropic resumes its provider
session, and Pi retains its stateful Agent and native steering queue for the
warm Sandbox lifetime. Direct client streaming is configured at the VM.

Each manifest targets an illustrative App slug. Create that App or change its
`app` value before running `cantelop deploy`; generated App IDs are never stored
in the example source.

Run all API and harness type checks plus deployment bundle smoke checks from
the repository root:

```bash
pnpm check:examples
```
