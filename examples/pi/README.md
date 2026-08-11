# Pi harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs Pi Agent Core and provider integrations in a
  Linux-native VM.

Cantelop injects a remote execution environment when it creates the API and
supplies provider credentials and Pi configuration only to the harness VM.

```bash
pnpm install
pnpm check
```
