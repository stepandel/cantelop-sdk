# OpenAI harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs in a Linux-native VM with the OpenAI Agents SDK.

Cantelop injects a remote execution environment when it creates the API and
supplies `OPENAI_API_KEY` only to the harness VM.

```bash
pnpm install
pnpm check
```
