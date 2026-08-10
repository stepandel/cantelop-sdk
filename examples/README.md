# Runtime examples

Each directory is a standalone Cantelop application using the same SDK surface
with a different user-owned harness runtime:

- `openai` uses the OpenAI Agents SDK.
- `anthropic` uses the Claude Agent SDK.
- `pi` uses Pi Agent Core.

The examples intentionally keep agent configuration inside their own packages.
Cantelop only receives an opaque runtime function, starts it through an execution
environment, and exposes it through an HTTP route.
