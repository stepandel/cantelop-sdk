# Native Codex in the SDK

Import the Node integration from `@cantelop/sdk/codex`. It runs the real Codex
app-server with Cantelop's native database driver. A stock OpenAI Codex binary is
rejected before startup because it cannot replace its SQLite connections.

```ts
import { createCodex } from "@cantelop/sdk/codex";

const codex = await createCodex({
  env: { CODEX_HOME: "/workspace/.codex" },
});
try {
  const thread = await codex.startThread({ cwd: "/workspace" });
  // Save thread.id in your application's session record to resume later.
  for await (const notification of thread.run("Inspect this repository")) {
    console.log(notification.method, notification.params);
  }
} finally {
  await codex.close();
}
```

Omit `database` to use the Session runtime's renewable workspace credentials.
Borrowed database clients must return integers without losing precision: use
`intMode: "bigint"` when constructing them. The integration closes clients it
creates and leaves borrowed clients open. Set `CANTELOP_CODEX_PATH` to the native
executable, or pass its path through `executable`.

## Build the native executable

The source recipe pins OpenAI Codex to
[`24edd7b89026865149d58d0a090694a2146b6d3c`](https://github.com/openai/codex/tree/24edd7b89026865149d58d0a090694a2146b6d3c)
and applies `native/upstream.patch`. There is no dependency on a separately
maintained GitHub fork. Install Rust 1.95.0 with rustup and the upstream Codex
platform build prerequisites, then run from this SDK checkout:

```sh
rustup toolchain install 1.95.0 --profile minimal
pnpm build:codex
export CANTELOP_CODEX_PATH="$PWD/native/bin/cantelop-codex"
```

`--source /path/to/checkout` and `--output /path/to/cantelop-codex` let you choose
build locations. The recipe refuses to overwrite a modified or mismatched
checkout. `--prepare-only` prepares the source without compiling it. Build for
the target Session platform; an executable built on macOS does not run in a
Linux Sandbox. Native executables are not downloaded automatically or included
in the JavaScript npm tarball.

## Storage coverage

Every Codex-owned SQL store uses the workspace connection: state and thread
metadata, projects, sections, attachments, agent relationships, goals, memory
versions, queued submissions, diagnostic logs, remote-control enrollment,
configuration imports, paginated history, and agent message boards. Logical
stores have separate migration ledgers and `cantelop_codex_<store>_` table prefixes.
The native SQLx driver does not load a local SQLite engine. Physical integrity,
vacuum and checkpoint maintenance belong to the hosted database.

This replaces SQLite persistence. Codex's canonical JSONL rollout files, config,
auth and other ordinary workspace files still use Codex's filesystem paths.
Keep the Codex home on the persistent workspace volume when resuming threads.
The paginated SQL history does not replace canonical model replay files.
Moving all canonical history into the DB requires a separate ThreadStore
implementation; this integration does not claim database-only replay.

The SDK starts an authenticated loopback bridge before native initialization.
The native child receives that process-scoped capability, not the workspace
credential-broker token. The native process owns migrations and SQL semantics;
the SDK provides the renewable database connection. SQL writes and timed-out
requests are never retried automatically. A transport failure can leave a
write's outcome unknown.

Unhandled native server requests, including approvals, are rejected. Supply
`onRequest` to implement the approval flow explicitly. Early iterator return or
an aborted `run` interrupts the active turn. `close()` waits for native thread
and log persistence before shutting down the bridge; shutdown failures are
reported to the caller.

## Verification

```sh
pnpm test
pnpm check:package
pnpm check:codex-native
pnpm check:codex-harness
# Also exercise every pinned upstream migration on a prepared checkout:
pnpm check:codex-native /path/to/prepared/codex
```

The protocol fixture tests are not a substitute for native harness tests. The
native driver checks use a temporary local libSQL database as test infrastructure,
while production connections use the workspace client.

`codex-native.yml` prepares and builds the pinned fork on Linux, runs the native
lifecycle smoke test against a mocked provider, and uploads the executable as a
CI artifact.
