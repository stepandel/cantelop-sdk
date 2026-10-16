# Workspace file synchronization

`workspace.sync()` is one Node.js capability for continuously reconciling a
local directory with `project/` inside one persistent Cantelop Workspace.
The public API does not expose filesystem CRUD or transfer commands.

```ts
const workspace = app.workspace({ slug: "my-project" });
const sync = await workspace.sync({
  localDirectory: process.cwd(),
  ignore: ["dist", "coverage"],
});

try {
  await sync.ready(); // Initial two-way reconciliation, including remote files.
  await sync.flush(); // Reconcile again before submitting work to an agent.
  // Run tools in /workspace/project. Workspace-level native login stays outside it.
  console.log(sync.status());
} finally {
  await sync.stop();
}
```

## Requirements and lifetime

This feature requires the matching Cantelop platform sync routes, a rebuilt App
Edge Worker, and a Cantelop CLI containing `internal-sync-files`. The SDK starts
that private native helper automatically; there is no new user-facing CLI
command. `CANTELOP_SYNC_HELPER` can select a specific CLI binary for development.
The first version supports macOS and Linux.

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

The server fixes the exposed directory to `/workspace/project`. Neither client
options nor transfer paths can select a host directory or reach Workspace login
files. Existing App integration authentication applies to every request. Those
credentials remain App-wide; this API does not create per-user Workspace grants.

Hosted mutations are disabled until an operator explicitly enables
`-workspace-sync-writes` after storage qualification. Pending uploads then reject
with `sync_writes_not_enabled` instead of being marked synchronized. Downloads
and reconciliation of already-matching content remain available.

Version preconditions are optimistic against ordinary filesystem writers.
They do not provide atomic compare-and-swap against concurrent POSIX/NFS writes.
The SDK preserves observed divergent changes, but does not promise that every
arbitrarily timed write is a separate recoverable revision. The rollout gate
must remain disabled until the deployed storage concurrency contract is tested.

## Cross-repository verification

SDK unit tests use a local protocol double so the package tests are self-contained.
Run the same suite against the real CLI helper after building the platform branch:

```sh
CANTELOP_SYNC_HELPER=/absolute/path/to/cantelop node --test test/sync.test.mjs
```

The platform's optional `TestWorkspaceSyncSDK` test connects this SDK's generated
Edge adapter and native local helper to the actual Go workspace file service.
Its invocation is documented in the platform's workspace sync guide.
