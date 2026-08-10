# Pi runtime example

This package adapts
[Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent)
to Cantelop's runtime-neutral execution environment.

```bash
npm install
cp .env.example .env
# Edit .env with the provider credential and desired PI_PROVIDER/PI_MODEL.
npm run dev
```

Alternatively, export the provider credential, `PI_PROVIDER`, and `PI_MODEL` in
the shell before starting the server.

Then create an execution:

```bash
curl http://localhost:3002/execute \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about ephemeral VMs"}'
```

Pi supports multiple model providers. Change `PI_PROVIDER`, `PI_MODEL`, and the
corresponding provider credential without changing Cantelop. The Pi agent loop
and model configuration remain entirely inside this package.
