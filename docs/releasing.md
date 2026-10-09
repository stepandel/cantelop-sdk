# SDK release boundary

The repository prepares a release without publishing it. The npm registry is a
production distribution boundary and requires a separate, reviewed operation.

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
public entrypoint, verifies removed Edge authoring exports, and builds generated Edge and native runtime artifacts. It deletes the tarball and
consumer afterward.

The package version is explicit in `package.json`; release automation must fail
if the tag is not exactly `sdk-v<version>`. A release commit must contain no
generated `dist` files because `prepack` rebuilds them from tracked source.

## Production operation

The source repository is `stepandel/cantelop-sdk`. Its manual
`.github/workflows/publish.yml` workflow uses npm trusted publishing and accepts
only the exact version already present in `package.json`. Prerelease versions
publish under the `next` dist-tag; stable versions publish under `latest`.
After npm publication succeeds, a separate job creates a GitHub Release for the
same existing tag, titled `SDK <version>`, with automatically generated release
notes. Prerelease versions are marked as GitHub prereleases and cannot become
the latest release. Only this job receives `contents: write`; the npm publishing
job retains `contents: read` and `id-token: write`.

The public repository uses npm trusted publishing, so published packages include
provenance linking them to this workflow and source repository. If the repository
is transferred, update `package.json`, the local Git remote, and npm's trusted
publisher owner before the next release.

The workflow never runs automatically. Merge the reviewed release commit to
`main`, create the signed `sdk-v<version>` tag on that commit, and push the tag.
An operator must then select the workflow manually, choose that tag as the
workflow ref, and provide the exact version. The workflow rejects branch refs,
lightweight tags, tags that are not reachable from `main`, and version/tag
mismatches. npm must already trust the repository and `publish.yml` workflow.
Immediately after publication, verify the registry tarball from a clean
consumer.

## Backfill or recover a GitHub Release

Existing tags do not automatically gain GitHub Releases when the workflow is
updated. If a version was already published to npm, create its missing GitHub
Release directly instead of rerunning npm publication. For example, after
confirming `@cantelop/sdk@0.14.0` is published:

```sh
gh release create sdk-v0.14.0 --repo stepandel/cantelop-sdk \
  --verify-tag --generate-notes --title "SDK 0.14.0"
```

For a prerelease, also pass `--prerelease --latest=false`. The same command can
recover a failed GitHub Release job after npm publication succeeds. Check
`gh release view <tag> --repo stepandel/cantelop-sdk` first to avoid recreating an
existing release. `--verify-tag` requires the tag to already exist on GitHub.
