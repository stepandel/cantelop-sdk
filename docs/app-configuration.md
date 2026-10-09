# App configuration

Instantiate a client bound to one existing App in your backend, then select its Workspaces and Sessions:

```ts
import { CantelopClient } from "@cantelop/sdk";
import { sessionRuntime } from "./definition.js";

const cantelop = new CantelopClient({ sessionRuntime });
const session = cantelop.workspace({ slug: "customer" }).session();
await session.dispatch(message);
```

The client resolves its App’s Edge origin and integration credential. To select another configured App, use `new CantelopClient({ sessionRuntime, slug: "support-agent" })` or `new CantelopClient({ sessionRuntime, id: "app_0123456789abcdef0123456789abcdef" })`. Add `profile: "production"` to select a named profile. Workspace ID/slug selectors and Session lifecycle remain unchanged.

This alpha implements SDK resolution. CLI credential provisioning and runtime injection still require the coordinated CLI/platform follow-ups. Existing CLI login credentials cannot authenticate this protocol. There is no separate hosting service involved: requests go to the selected App's deployed Edge Worker at `POST {app_url}/commands`.

The required `sessionRuntime` is a portable definition, not executable agent code. Client types come from that definition. App identity/credentials remain automatic; see [runtime definition enforcement](runtime-definitions.md).

## Configuration sources

App identity uses the first available selection in this order:

1. An explicit `id` or `slug` argument.
2. The selected profile's `defaultApp` in runtime-injected configuration.
3. The selected profile's `defaultApp` in `CANTELOP_APP_CONFIG`.
4. `CANTELOP_APP_ID` or `CANTELOP_APP_SLUG`.
5. The nearest ancestor `cantelop.json` file's `app` slug (Node backends).
6. The local integration profile's `defaultApp`.

Credentials for that selected App are looked up in runtime configuration, `CANTELOP_APP_CONFIG`, App-bound environment credentials, then the local integration profile. A credential for another App is never used as a fallback. A profile argument overrides `CANTELOP_PROFILE`; otherwise each configuration document uses its `activeProfile`. A requested profile missing from a consulted document fails with `app_not_configured`.

Environment-only deployment can supply `CANTELOP_APP_SLUG` and `CANTELOP_INTEGRATION_TOKEN`. The SDK derives `https://{slug}.cantelop.dev`; `CANTELOP_EDGE_URL` can override it. When supplying only `CANTELOP_APP_ID`, supply `CANTELOP_EDGE_URL` as well. If both ID and slug are provided, they must identify the same App. An environment token requires an explicit environment App identity; it does not become a global credential.

`CANTELOP_APP_CONFIG` contains the JSON document described below. Managed runtimes can inject the same document at `globalThis[Symbol.for("dev.cantelop.sdk.app-config.v1")]` before constructing the client. Both mechanisms support backends without filesystem access. Credentials belong in trusted backend configuration; these are server-side integration clients.

## Local integration profiles

The Node adapter reads a separate `integration.json`, never the CLI's administrative login credential file. Its default location is:

- macOS: `~/Library/Application Support/cantelop/integration.json`
- Linux: `$XDG_CONFIG_HOME/cantelop/integration.json`, or `~/.config/cantelop/integration.json`
- Windows: `%APPDATA%/cantelop/integration.json`

`CANTELOP_INTEGRATION_CONFIG` overrides that path. When `CANTELOP_CONFIG` selects a CLI login file, its sibling `integration.json` is used unless the integration path is explicitly set. The login file's contents are not read. `CANTELOP_PROJECT_CONFIG` overrides project manifest discovery. Explicit or injected App selections skip project discovery.

The versioned profile document looks like this:

```json
{
  "schemaVersion": 1,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "defaultApp": { "slug": "support-agent" },
      "apps": [
        {
          "id": "app_0123456789abcdef0123456789abcdef",
          "slug": "support-agent",
          "accessToken": "APP_INTEGRATION_CREDENTIAL"
        }
      ]
    }
  }
}
```

An App record may include `edgeUrl` for a deployment origin override and `expiresAt` for credential expiry. Each record maps a canonical ID to a slug, allowing either selector without platform API discovery. IDs and slugs must be unique within a profile. Profile files are bounded to 1 MiB and must be private on POSIX systems, for example mode `0600`. Keep them out of source control. The compatible CLI will create and refresh these App integration profiles; manual configuration is available for qualification before that follow-up ships.

## Resolution and failures

Constructing a client, Workspace or Session reference does not make a network request. Runtime/environment values and the working directory are captured when the client is constructed. Local files are read lazily on the first operation requiring a connection. Concurrent operations share resolution. A failed resolution can retry after local configuration is repaired; successful connections remain fixed for that client instance. Create a new client after changing environment/runtime configuration or rotating a resolved credential.

`AppConfigurationError` exposes a redacted `code`: `app_configuration_missing`, `app_configuration_invalid`, `app_not_configured` or `app_credentials_expired`. Configuration failures occur before command submission and are not ambiguous execution failures.

Advanced integrations can still provide `new CantelopClient({ sessionRuntime, edgeUrl, accessToken })` or `new CantelopClient({ sessionRuntime, connection })`. These explicit transports cannot be combined with App identity or profile options. Origins require HTTPS, with HTTP permitted only for localhost or numeric loopback development addresses. The default backend path is `new CantelopClient({ sessionRuntime })`, optionally with an App selector; transport details stay in configuration.
