# App webhooks

An App can declare optional HTTP ingress handlers alongside its Session runtime. Use these for headless integrations that receive provider events directly at the App hostname. Existing application backends can continue receiving webhooks on their own routes and using the SDK.

```ts
const cantelop = new CantelopClient();

export const support = cantelop.app<Message, Event, Reply, View>({
  name: "support-agent",
  runtime: { receive },
  webhooks: {
    "/webhooks/github": { method: "POST", handle: handleGitHub },
  },
  environment: {
    GITHUB_WEBHOOK_SECRET: { secret: true, required: true },
  },
});
```

Handlers receive a typed `WebhookContext<Message, Event, Reply, View>` and return a standard `Response`, synchronously or asynchronously:

```ts
async function handleGitHub({ request, app, env }: WebhookContext<Message, Event, Reply, View>) {
  const event = await verifyAndParseGitHub(request, env.GITHUB_WEBHOOK_SECRET);
  await app.workspace({ slug: event.workspaceSlug })
    .session({ id: event.sessionId })
    .dispatch(event.message, { id: event.messageId, signal: request.signal });
  return new Response(null, { status: 202 });
}
```

`verifyAndParseGitHub` above is application code, not an SDK helper. See the [GitHub example](../examples/github/README.md) for an implementation.

## Optional homepage

An App can also provide a homepage handler for `/`:

```ts
export const support = cantelop.app<Message>({
  name: "support-agent",
  runtime: { receive },
  homepage: ({ app }) => new Response(`<h1>${app.name}</h1>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }),
});
```

`homepage` accepts an inline or imported function, a method, or a shorthand property. Its `AppRequestContext<Message, Event, Reply, View>` supplies the same typed App, Request and declared environment values as webhooks. `HomepageHandler` is exported for separately typed functions. The handler returns a standard Response and chooses its headers/content type.

A configured homepage is public at the App hostname's root. GET invokes it normally; HEAD invokes it and returns status/headers with no body. Other methods return 405 with `Allow: GET, HEAD`. Unexpected errors return a generic `homepage_failed` 500. If omitted, no root route is added and existing protocol routing behavior remains unchanged.

The compiler includes homepage dependencies only in Edge and removes the handler from backend definitions. Homepage-only edits preserve Session identity. This does not add static asset serving or a general route surface; inline assets or independently hosted assets can be used. CLI/platform adoption must permit public root requests to reach the generated Worker, alongside provider-authenticated webhook ingress.

## Execution boundaries

The compiler extracts webhook functions and their dependencies into the generated Edge Worker. It extracts `runtime` handlers into the Sandbox artifact. The backend transform removes both implementations and preserves the named App handles and their exports. Imports and closures shared between implementations follow their respective dependency graphs.

The webhook context supplies the current App with its normal `workspace(...).session(...).method(...)` contract, including Workspace ID/slug selection, typed messages/events/replies/views, keep-alive options and submission IDs. Its internal connection invokes the same Edge command implementation locally, without a self-directed HTTP call, integration token or configuration lookup. It does not expose private platform paths. External `/commands/*` calls still require integration authentication and matching runtime identity.

Handlers must use the context's App rather than capture/import the enclosing App instance. App definitions remain declarative: route paths/options are inline literals; handlers may be imported functions, closures or inline implementations. No module evaluation occurs during extraction. Each App receives only its own routes. Webhook implementation edits do not change Session compatibility identity; runtime/type/configuration edits still can. Redeploy the Edge artifact when webhook code changes.

## HTTP and provider behavior

- Routes are exact paths beneath `/webhooks/`, with one `GET` or `POST` method per path. They do not support wildcards, path parameters, middleware registration or a general API router. `/commands/*` is reserved.
- Routes receive the original headers, URL/query and exact body bytes. Bodies are limited to 1 MiB before the handler runs; larger bodies receive 413. Wrong methods receive 405 with `Allow`.
- Each handler verifies its provider's authentication before using the App. Cantelop does not authenticate provider requests automatically. URL challenges and ignored events can return directly without activating a Session.
- `env` is a frozen snapshot of the App’s declared environment values, including both ordinary variables and secrets. Explicit bindings override declared defaults. Optional unset values are `undefined`; undeclared values and reserved Cantelop bindings are excluded. Missing/empty required values return `app_environment_missing` (503), and non-string values return `app_environment_invalid` (503), before invoking the handler. `secret: true` describes deployment storage; it does not change how a value is accessed.
- A webhook should acknowledge after `dispatch`/`steer` admission, not after agent completion. Failed admission must not return success. There is no additional durable ingress queue or SDK provider retry scheduler; the upstream provider's deadline must allow command admission.
- Map retry deliveries to stable Workspace, Session and message IDs. The SDK's `msg_` IDs require 32 hexadecimal characters; hash provider delivery IDs into that format. Idempotent admission does not guarantee exactly-once outbound side effects.
- Agent replies to GitHub, Slack or Telegram are separate outbound API calls from the runtime. The webhook Response is only the provider acknowledgement.
- Unexpected handler errors and invalid Response values return a generic `webhook_failed` 500 without exception details or binding values. Handlers can return explicit provider-specific error Responses.

## Deployment

The Edge manifest lists webhook paths/methods; deployment still uses a generated Worker rather than a customer API entrypoint. The CLI/platform must deploy this artifact and synchronize the declared secrets into Edge bindings as well as the runtime environment. The platform ingress must permit webhook paths to reach the Worker without requiring the integration bearer token used by `/commands/*`. Provider verification runs inside the webhook handler.

The current prerelease's CLI/platform adoption remains a follow-up. No provider webhook registration, managed subscriptions or provider adapters are included. The unpublished protocol/schema versions stay unchanged.
