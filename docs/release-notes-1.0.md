# Cantelop SDK 1.0

## 1.0.1

- **Runtime IDs no longer depend on where the project is checked out.** In 1.0.0, an App's runtime ID could include the absolute path of the project, for example when its types used `Partial<…>` of an SDK type, as the `@cantelop/sdk/harnesses/claude/protocol` types do. A backend client built in a different directory from the one `cantelop deploy` ran in, such as in CI, then got `session_runtime_mismatch` (409) on every Session command. The same sources and dependencies now produce the same runtime ID in any directory, and module paths in the runtime bundle are relative to the App definition instead of the directory the build runs from.
- **Runtime IDs change once more.** Upgrading to 1.0.1 changes every App's runtime ID. Rebuild and redeploy both the App and your backend with 1.0.1: a backend built with 1.0.0 gets 409s from an App deployed with 1.0.1, and the reverse.
- **Pre-1.0 compatibility code is removed.** The Session runtime accepts native auth commands only on Workspace-scoped auth Sessions, and the Claude runtime no longer reads queue state saved before 1.0.0-alpha.9. Public exports are unchanged.

## 1.0.0

The first stable release of `@cantelop/sdk`, the backend integration and Session runtime SDK for Cantelop Apps.

### Requirements

- Node.js 22 or newer
- Cantelop CLI 0.15.2 or newer
- Bun 1.3.10 for local development, or Docker with `cantelop dev --container`

```sh
npm install @cantelop/sdk
```

### What's in 1.0

- **Apps, Workspaces and Sessions from your backend.** `new CantelopClient()` and `cantelop.app({ name, runtime })` declare typed, named Apps. `app.workspace({ slug })` or `app.workspace({ id })` and `.session({ id })` return lazy references with `dispatch`, `steer`, `request`, `cancel`, `stop`, `stream` and message `status()`.
- **You write the Session runtime; the SDK generates the Edge API.** A runtime's `create` factory returns a harness with `queue`, `steer` and `cancel`, and the lower-level `receive` runtime covers custom orchestration. The compiler in `@cantelop/sdk/build` builds a Sandbox runtime and a protocol-managed Edge Worker for each App, and strips runtime-only dependencies from your backend.
- **One command path per SDK call.** Every operation is `POST /commands/{type}` with a versioned envelope (integration protocol 2), so request logs and the Cantelop console show which SDK call each request was.
- **Workspace databases.** Each Workspace gets a libSQL database shared by your backend and its Sessions. Declare tables in `db/schema.ts` with `@cantelop/sdk/schema`, and Cantelop generates and applies the migrations.
- **App webhooks and homepage.** Declare `webhooks` routes and an optional public `homepage` on an App. Their handlers run on the App's Edge with the same typed App interface.
- **Native CLI sign-in.** Declare `auth` on an App so each Workspace can sign in to a stock CLI with the user's own subscription. The structured link/code login (`login`, `submitCode`, `cancelLogin`) needs no terminal UI.
- **Packaged Claude Code harness.** `@cantelop/sdk/harnesses/claude` provides `createClaudeHarness`, `createClaudeRuntime`, `claudeAuth` and `claudeDockerfile`.
- **Integration token rotation.** The generated Edge accepts the previous integration token until it expires, so `cantelop app credentials rotate` causes no downtime.

The repository also has examples for OpenAI Agents, Codex, OpenCode, Pi, a web chat app, a GitHub webhook agent and a multi-App project.

### Good to know

- Any change to an App's runtime logic or types changes its runtime identity. A backend built against the previous runtime gets `session_runtime_mismatch` (409) on Session commands until it is rebuilt and redeployed, so deploy your backend and App together. See [deploy the backend with the App](https://github.com/stepandel/cantelop-sdk/blob/main/docs/runtime-definitions.md#deploy-the-backend-with-the-app).
- Durable Session views (`view.commit()`, `session.view()`) and the browser-relayed native auth terminal are not yet available on hosted Cantelop.

See the [README](https://github.com/stepandel/cantelop-sdk#readme) to get started.
