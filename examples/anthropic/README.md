# Anthropic runtime example

This package adapts the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
to Cantelop's runtime-neutral execution environment.

```bash
pnpm install
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY.
pnpm dev
```

Alternatively, export `ANTHROPIC_API_KEY` in the shell before starting the
server.

Then create an execution:

```bash
curl http://localhost:3001/execute \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about ephemeral VMs"}'
```

Stream the response over server-sent events:

```bash
curl -N http://localhost:3001/execute/stream \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about ephemeral VMs"}'
```

The Claude agent loop and its configuration belong entirely to this package.
Cantelop only starts the runtime function and exposes its lifecycle through an
execution.
