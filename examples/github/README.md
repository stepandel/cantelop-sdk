# Headless GitHub issue agent

GitHub sends newly opened issues directly to the App's `/webhooks/github` route. The Edge handler verifies the HMAC signature over the raw payload, selects a repository Workspace and issue Session, and dispatches a typed message. The Sandbox runs an OpenAI agent and posts its answer as an issue comment using the GitHub API.

- `src/cantelop.ts` defines the App, webhook route, Session runtime and environment declarations.
- `src/github.ts` verifies and translates GitHub deliveries. It uses the same `app.workspace(...).session(...).dispatch(...)` contract as backend code.
- `src/homepage.ts` serves a small public description at `/`, configured with the optional `homepage` property.
- `src/agent.ts` contains the runtime and outbound comment operation. OpenAI dependencies stay out of the Edge and backend artifacts.
- `src/contracts.ts` defines the shared message type.

Repository numeric IDs map to `repo-<id>` Workspace slugs; issue numbers map to `issue-<number>` Session IDs. Delivery IDs are hashed into stable submission IDs so retries target the same message. Signed ping/irrelevant events return 204 without activating a Sandbox. Successful message admission returns 202; agent completion happens afterward.

## Configure

With a compatible CLI/platform, deploy the generated Edge/Sandbox artifacts and configure:

- `GITHUB_WEBHOOK_SECRET`: the secret configured on the repository webhook; read as `env.GITHUB_WEBHOOK_SECRET` on Edge. All required App environment values must be provisioned before invoking HTTP handlers.
- `GITHUB_TOKEN`: a token restricted to the target repository with permission to write issue comments; used by the runtime.
- `OPENAI_API_KEY`: used by the runtime.
- `OPENAI_MODEL`: defaults to `gpt-5-mini`.

Configure the GitHub repository webhook to send issue events as JSON to `https://<app-host>/webhooks/github`. The route authenticates GitHub signatures, so provider requests need no Cantelop integration bearer token. Prefer a private test repository when trying the example: it sends issue text to OpenAI and publishes the generated comment.

Run `pnpm --filter @cantelop/example-github check` to type-check locally; `pnpm check:examples` qualifies compiler boundaries and matching artifacts. The current prerelease needs coordinated CLI/platform adoption before deployment. Nothing registers a GitHub webhook automatically.

The handler acknowledges only after admission. Cantelop does not add an ingress queue or guarantee exactly-once comment publication; retries after an ambiguous outbound API result need application-level reconciliation.
