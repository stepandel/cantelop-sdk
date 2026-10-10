# Client context and named App connections

The client is independent of App identity and runtime:

```ts
const cantelop = new CantelopClient();
// Or: new CantelopClient({ profile: "production" });

export const support = cantelop.app({
  name: "support-agent",
  runtime: { receive },
});
const session = support.workspace({ slug: "customer" }).session();
```

`name` is the App's existing deployment slug, scoped to the selected account/environment. Each App resolves only its own Edge origin and integration credential. The SDK never reads administrative CLI login credentials or borrows another App's token. `cantelop.json` identifies a definition module and does not supply App identity; profile defaults cannot override an explicitly named App.

Constructing a client, App, Workspace, or Session does not contact the network or provision resources. The client captures its profile, runtime/environment context and directory once. Local integration files are read lazily when an App first needs a connection; concurrent operations on that App share resolution. Failures can retry after local credentials are repaired. Successful connections remain fixed for that App instance. Create a new client after changing captured environment configuration.

## Scoped CLI/runtime configuration

The CLI/platform follow-up must provide integration credentials scoped to named Apps. A private integration profile can include several:

```json
{
  "schemaVersion": 1,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "apps": [
        {
          "id": "app_11111111111111111111111111111111",
          "slug": "support-agent",
          "accessToken": "<App-scoped integration credential>"
        },
        {
          "id": "app_22222222222222222222222222222222",
          "slug": "research-agent",
          "accessToken": "<different App-scoped credential>"
        }
      ]
    }
  }
}
```

Reserved `CANTELOP_APP_CONFIG` or the runtime injection point can supply the same document. `CANTELOP_INTEGRATION_CONFIG` selects a private integration file. Default file discovery uses Cantelop's integration profile directory, independently of CLI administrative login files; profile files require private permissions on Unix. `CANTELOP_PROFILE` selects a profile unless the client explicitly supplies one. Invalid/expired credentials fail without including their values in errors.

For a single named App, environment configuration can supply `CANTELOP_APP_SLUG` and `CANTELOP_INTEGRATION_TOKEN`, with optional `CANTELOP_EDGE_URL`. A slug is necessary to match the code's App name; an App ID alone cannot match it. Other Apps require their own matching profile/injected record and cannot reuse this credential.

Normally the backend compiler embeds generated runtime identity. For uncompiled local development, CLI-managed App records may carry `runtimeId`, or matching environment configuration may inject `CANTELOP_SESSION_RUNTIME_ID`. These are generated system metadata, not constructor options. Compiled identity takes precedence over configuration. See [runtime compilation](runtime-definitions.md).

## App-specific overrides

Advanced transport overrides belong on an App, so one client's other Apps retain their own routing/authentication:

```ts
const app = cantelop.app({
  name: "test-agent",
  runtime: { receive },
  connection: { async fetch(request) { return testEdge.fetch(request); } },
});
```

A custom connection owns routing, authentication and reserved metadata. Alternatively supply `edgeUrl` and `accessToken` together on the App. URLs require HTTPS, with HTTP loopback permitted for local development. Credentials are backend-only; SDK transport does not follow redirects.

Runtime handlers, provider environment declarations and optional Dockerfile configuration also belong on the App. Actual provider secrets are injected into its Sandbox by coordinated CLI/platform support. See [the definition contract](runtime-definitions.md).
