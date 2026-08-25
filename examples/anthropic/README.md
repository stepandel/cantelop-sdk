# Anthropic harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/session.ts` defines Session logic that runs the Claude Agent SDK and its
  subprocess in a Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; Anthropic credentials are
supplied only to the harness VM.

The API exposes `GET /health`, `POST /chat`, `POST /steer`, and `POST /cancel`.
Chat requires `workspaceId`, `keepAliveSeconds`, and `prompt`, and accepts an
optional `sessionId`; it creates or reuses that Session. Steer requires
`sessionId`, `workspaceId`, `keepAliveSeconds`, and `prompt` to reuse it. Cancel
requires the same Session fields without a prompt. All message routes return an
in-memory acceptance receipt with status `202`.

The message routes target the App's single Session logic. Its `receive`
entrypoint handles each message. The
application message identifies chat, steer, or cancel intent; this example
resumes the Session's Claude
provider session and applies either prompt as its next turn. The active query is
a runtime-managed Session activity: steer queues the next turn without
blocking the mailbox, while cancel aborts the Claude query and clears queued
prompts.

`cantelop.json` targets an illustrative App with slug `anthropic`. Change the
slug when deploying to a different App.

```bash
pnpm install
pnpm check
```
