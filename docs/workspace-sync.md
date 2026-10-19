# Workspace file synchronization

`workspace.sync()` is one Node.js capability for continuously reconciling a
local directory with all or part of one persistent Cantelop Workspace.
The public API does not expose filesystem CRUD or transfer commands.

```ts
const workspace = app.workspace({ slug: "my-project" });
const sync = await workspace.sync({
  localDirectory: process.cwd(),
  remoteDirectory: "my-project", // Relative to /workspace; "" selects all of it.
  ignore: ["dist", "coverage"],
});

try {
  await sync.ready(); // Initial two-way reconciliation, including remote files.
  await sync.flush(); // Reconcile again before submitting work to an agent.
  // Run tools in sync.remoteDirectory (/workspace/my-project in this example).
  console.log(sync.status());
} finally {
  await sync.stop();
}
```

`remoteDirectory` is a canonical relative path inside the selected Workspace.
It may contain multiple components. An explicit empty string synchronizes the
whole `/workspace`; omitting the option retains `/workspace/project` for
compatibility with SDK 1.1.0. `sync.remoteDirectory` reports the absolute remote
path. The selected root is recorded with local baseline hashes; reusing the same
local directory and Workspace with a different root rejects with
`sync_invalid_state`, rather than reinterpreting prior deletions. To change roots,
use a different local directory, or stop the handle and delete that
Workspace's baseline `<workspace-id>.json` under the sync state directory
(`$CANTELOP_SYNC_STATE_HOME`, else `~/Library/Application Support/cantelop/sync`
on macOS or `$XDG_STATE_HOME/cantelop/sync` on Linux); the next start then
reconciles without prior deletions.

## Requirements and lifetime

This feature requires the matching Cantelop platform sync routes and a rebuilt
App Edge Worker. The SDK package includes its own native filesystem adapter for
macOS and Linux on arm64 and x64. It starts that adapter by its package-relative
absolute path; the Cantelop CLI and Go are not required on consumer machines.
There are no runtime downloads or install scripts. `CANTELOP_SYNC_HELPER` is no
longer used. An incomplete SDK installation reports `sync_helper_unavailable`;
reinstall the SDK instead of installing or upgrading the CLI.

Source contributors need Go 1.26.2 or newer; see [the native build](../native/README.md).

The helper uses the platform's traversal-resistant Go filesystem implementation
for local file access. It listens only on numeric loopback, requires a random
parent-only bearer credential, and exits when the SDK closes its parent pipe.
App and infrastructure credentials are not passed to the helper. Native OS
locking prevents two handles from owning one local directory and is released
after a process crash.

Sync lives independently of agent Sessions but lasts only while the calling
process and handle are alive. A consumer such as Juiced can own the handle in a
background process; the SDK does not install or start a machine-wide daemon.
`stop()` aborts transfers and releases resources; it does not delete either tree.
An optional `signal` also stops the handle. Always stop it during application
shutdown.

## Reconciliation and conflicts

The client stores last agreed hashes outside the working tree: under
`~/Library/Application Support/cantelop/sync` on macOS, and
`${XDG_STATE_HOME:-~/.local/state}/cantelop/sync` on Linux.
`CANTELOP_SYNC_STATE_HOME` can override that location for development; the helper
rejects state directories inside the synchronized tree. Native locking uses the
directory inode itself, so Git clean and alternate metadata locations cannot
allow two handles to own the same directory.

At first connection, one-sided files are copied and matching files are adopted.
Differing files at the same path are conflicts. Later reconciliation compares
both sides with the last agreed version. Nonconflicting edits and deletions
propagate in either direction. Simultaneous divergent edits, including an edit
against a deletion, leave the conflicting paths untouched. Other paths can
continue syncing. Resolve a conflict by making both sides agree or restoring one
side to its last agreed version, then call `flush()`.

`ready()` and `flush()` reject on conflicts or transfer failures. A conflict is
reported as `WorkspaceSyncError` with code `sync_conflict`, with paths available
through `status().conflicts`. Failed background cycles update `status()` and retry
on the next poll. A fresh manifest on reconnect handles edits made while offline.
`flush()` describes the reconciliation it performed; another writer can change a
file immediately afterward.

Hashes include content and the executable bit. Downloads are verified before
publication. Regular files, binary content, and executable bits are supported;
empty directories, symlinks, hard links, special files, and case-colliding names
are not supported. Files are limited to 16 MiB; each scan is limited to 10,000
entries and 128 MiB of file content. Polling defaults to one second and can be
set with `pollIntervalMs` (100–60,000).

`.git`, `.cantelop`, `node_modules`, `.env*`, and `.cantelop-sync-*` entries are
excluded on both sides. Additional `ignore` entries are literal relative paths
or directory prefixes, not glob patterns. They exclude reconciliation; the
platform still applies its scan and unsupported-entry limits to the exposed root.

## Security and hosted rollout

The security boundary is the authenticated Workspace. A relative root narrows
one handle's transfers, without granting a different identity or changing the
Workspace. No host path or other Workspace can be selected. Each root component
is opened without following symlinks. There is no server binding, schema migration,
or special treatment of a particular agent's files.

Whole-Workspace sync includes agent account state stored there unless excluded.
Consumers should select a project subdirectory when account files must stay
remote. Juiced selects `/workspace/<local-folder-name>` and leaves sibling
`.claude` and `.local` directories in place. Existing App integration
authentication applies to every request and remains App-wide; this API does not
create per-user Workspace grants.

Hosted mutations are disabled until an operator explicitly enables
`-workspace-sync-writes` after storage qualification. Pending uploads then reject
with `sync_writes_not_enabled` instead of being marked synchronized. Downloads
and reconciliation of already-matching content remain available. After a valid
manifest, `status().writable` reports whether hosted mutations are enabled.
Consumers requiring writable projects should check it even for empty trees.

Version preconditions are optimistic against ordinary filesystem writers.
They do not provide atomic compare-and-swap against concurrent POSIX/NFS writes.
The SDK preserves observed divergent changes, but does not promise that every
arbitrarily timed write is a separate recoverable revision. The rollout gate
must remain disabled until the deployed storage concurrency contract is tested.

## Cross-repository verification

SDK sync tests use the packaged native adapter against a local remote-transport
double. Run `pnpm test` to exercise real filesystem access and OS locks, including
a transfer with an empty `PATH`. `pnpm check:package` cross-builds all four release
binaries and tests sync from a tarball installed with `--ignore-scripts`. No CLI
installation, account credentials, or Go compiler is needed by that consumer.

The platform's optional `TestWorkspaceSyncSDK` test connects this SDK's generated
Edge adapter and native local helper to the actual Go workspace file service.
Its invocation is documented in the platform's workspace sync guide.
