# OpenAI runtime example

This package adapts the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
to Cantelop's runtime-neutral execution environment.

```bash
export OPENAI_API_KEY=...
npm run dev
```

Then create an execution:

```bash
curl http://localhost:3000/execute \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about ephemeral VMs"}'
```

The OpenAI agent and its configuration belong entirely to this package. Cantelop
only starts the runtime function and exposes its lifecycle through an execution.
