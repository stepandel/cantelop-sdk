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

## Select a native executable

Native source, upstream updates, builds, and binary releases live in
[`stepandel/cantelop-codex-native`](https://github.com/stepandel/cantelop-codex-native).
The native repository has its own version and release cycle. Updating upstream
Codex does not require an SDK release unless the storage protocol or TypeScript
API changes.

Use a verified executable from that repository's CI artifacts or tagged releases,
or build it from its checkout:

```sh
git clone --branch cantelop git@github.com:stepandel/cantelop-codex-native.git
cd cantelop-codex-native
rustup toolchain install "$(node cantelop/scripts/toolchain.mjs)" --profile minimal
npm --prefix cantelop run build
export CANTELOP_CODEX_PATH="$PWD/cantelop/bin/cantelop-codex"
```

Build for the target Session platform; a macOS executable does not run in a Linux
Sandbox. The SDK does not automatically download native binaries or bundle them
in its npm tarball. The native repository is a public GitHub fork of OpenAI Codex. Its default
`cantelop` branch contains the workspace integration; `main` retains upstream
source.

The executable must advertise storage protocol **1**, backend `workspace`,
`localSqlite: false`, and every required storage domain. The SDK validates its
preflight probe and initialization response. Native release metadata records
these capabilities, its pinned upstream revision, and the tested SDK revision;
select a compatible native release independently of the SDK version. The native
repository documents the wire contract and upstream merge process in
`cantelop/README.md` and verifies compatibility in CI.

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
# Requires a compatible native executable from the separate repository:
CANTELOP_CODEX_PATH=/path/to/cantelop-codex pnpm check:codex-harness
```

The SDK owns protocol fixture tests, package import checks, and the real native
lifecycle smoke test. The native repository owns Rust driver checks, every
pinned upstream migration, compilation, and executable release artifacts. Its
CI runs the SDK's real lifecycle test against a pinned SDK checkout and a mocked
provider. Native test infrastructure uses a temporary local libSQL database;
production connections use the workspace client.
