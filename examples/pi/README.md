# Pi harness example

This example has two deployment artifacts:

- `src/api.ts` is Edge middleware and imports no provider SDK.
- `src/harness.ts` runs Pi Agent Core and provider integrations in a
  Linux-native VM.

Cantelop injects the current App when it creates the API. The Edge API manages
Workspaces and reusable Sessions without an API key; provider credentials and
Pi configuration are supplied only to the harness VM.

`cantelop.json` targets an illustrative App with slug `pi`. Change the slug
when deploying to a different App.

```bash
pnpm install
pnpm check
```
