# OpenAI harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs in a Linux-native VM with the OpenAI Agents SDK.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; `OPENAI_API_KEY` is
supplied only to the harness VM.

```bash
pnpm install
pnpm check
```
