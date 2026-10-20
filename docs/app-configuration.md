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

Cantelop issues integration credentials scoped to named Apps. A private integration profile can include several:

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

On a hosted backend, `cantelop app credentials --app <slug>` prints these values in dotenv form for the host's secret store. `cantelop app credentials rotate` issues a new token; the generated Edge keeps accepting the previous token until the expiry the platform sets (24 hours by default), so the backend can be updated without downtime.

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

Runtime handlers, provider environment declarations and optional Dockerfile configuration also belong on the App. Cantelop injects the actual provider secrets, set through the CLI, into its Sandbox. See [the definition contract](runtime-definitions.md).

## Updating deployed environment values

Use the named App's existing integration connection; no administrative login or
Cantelop CLI process is involved:

```ts
const environment = app.environment();
const update = await environment.set("GH_TOKEN", token, { secret: true, signal });
await environment.wait(update.revision, { signal, timeoutMs: 120_000 });
const removal = await environment.unset("GH_TOKEN", { secret: true, signal });
await environment.wait(removal.revision, { signal });
```

The live App must declare `GH_TOKEN: { secret: true }` in `environment`.
`set` and `unset` return only `{ revision, status }`; `status(revision)` reports
`pending`, `applied`, or `failed`. Secret values cannot be read through this API.
`wait` checks propagation to both Edge and compute, supports cancellation and a
bounded timeout, and reports projection failures. A timeout does not undo a
stored update; the returned revision can be checked again. A later applied
configuration revision also satisfies a wait for an earlier one.

Values are app-wide. Ordinary variables use `secret: false` (the SDK default).
Only declared names with matching kinds can be mutated; reserved `CANTELOP_*`
names and removal of required values without a default are rejected. An optional
request `id` correlates the response; retrying a mutation can create another
configuration revision. The transport uses explicit
`app.environment.set`, `app.environment.unset`, and `app.environment.status`
commands with null Workspace and Session, without allocating either resource
or checking Session runtime compatibility. Updates use the encrypted control
plane and existing configuration projection worker, without creating a release.
New Sandboxes receive the new values; existing process environments are not
modified. The Claude runtime image includes `gh` for applications that configure
Git's GitHub CLI credential helper.

Roll out the platform's App-scoped environment gateway and redeploy the App with
SDK 1.4.0 once before using this API. Later environment changes require no build
or deployment. These APIs manage a deployed App; local `cantelop dev` environment
configuration continues to come from its local environment file.


## Bind a compiled definition to a managed service

`app.runtimeId` exposes the compiler fingerprint (or `undefined` for an
uncompiled definition). A managed service can use this to require an exact
client/runtime pair before provisioning or accepting work.

`app.connect({ fetch })` returns a new App with the same compiled runtime,
auth declaration and environment definition, bound to a trusted transport. The
original App and previously created Workspace/Session references keep their
connections. Capture one account/installation in that transport for its whole
lifetime; a later account switch should construct another App.

```ts
const installation = await bootstrap({ runtimeId: app.runtimeId });
const scoped = app.connect({
  fetch(request) {
    return relayForInstallation(installation, request);
  },
});
await scoped.workspace({ slug: "project" }).resolve();
```

`@cantelop/sdk/protocol` exports the versioned command and sync validators for
services that relay SDK traffic. `validateCommandRequest(method, url, body)`
checks the path, method, query, size and envelope together, including that the
envelope's command type matches its path; authorize account membership and bind server credentials independently. The
validators do not authenticate a request. Preserve streams, backpressure,
submission IDs and cancellation, and do not replay an ambiguous mutation.
