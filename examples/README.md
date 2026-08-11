# Runtime example

The `edge` directory contains a standalone Cantelop application compiled
without Node.js types or deployment-provider APIs. It demonstrates the runtime
surface available to application developers:

- `POST /execute` waits for the final result.
- `POST /execute/stream` streams application-defined events over SSE.

Provider credentials and infrastructure bindings are deliberately absent.
Cantelop may expose selected platform features later through explicit,
provider-neutral capabilities.
