# Edge runtime example

This example is compiled using only standard ECMAScript and Web Platform types.
It demonstrates request/response handling, request cancellation, and streaming
without access to Node.js or deployment-provider APIs.

```bash
pnpm install
pnpm check
```

The default export is a Cantelop application. Cantelop's deployment system owns
the platform-specific adapter that passes incoming `Request` objects to
`app.handle(request)`.
