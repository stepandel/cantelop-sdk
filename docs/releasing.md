# SDK release boundary

The repository prepares a release candidate without publishing it. The npm
registry is a production distribution boundary and requires a separate,
reviewed operation.

## Pre-production qualification

Run with the pinned package manager and Node.js 22 or newer:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm check:examples
corepack pnpm check:package
```

The last command creates an ephemeral `npm pack` tarball, verifies that all
JavaScript and declaration targets in `exports` are present, rejects source and
test directories, installs the tarball into an empty consumer, imports every
public entrypoint, and builds an API artifact. It deletes the tarball and
consumer afterward.

The package version is explicit in `package.json`; release automation must fail
if the tag is not exactly `sdk-v<version>`. A release commit must contain no
generated `dist` files because `prepack` rebuilds them from tracked source.

## Production operation

Publishing is deliberately not scripted as part of qualification. After the
candidate commit and tag are reviewed, the production operator may publish the
same qualified version with npm provenance and immediately verify the registry
tarball from a clean consumer. That credentialed publication, tag creation, and
registry verification belong to the production operations milestone.
