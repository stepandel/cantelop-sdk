# SDK filesystem adapter

The SDK builds this private executable into `dist/native/<os>-<arch>/sync-helper`.
Release packages contain macOS and Linux executables for arm64 and x64. Registry
consumers need neither Go nor the Cantelop CLI, even with install scripts disabled.
Source builds require Go 1.26.2 or newer. `pnpm build` builds the host executable;
`node scripts/build-sync-helper.mjs --all` builds all release targets without CGO.
The npm `prepare` lifecycle builds every release target so source installs,
`npm pack`, and `npm publish` retain all four binaries. Package qualification
runs that lifecycle before checking the tarball.

`platform/` is a source snapshot of the filesystem implementation and its Go
dependencies from `stepandel/cantelop` commit
`06e4c2faed09343f3937e7b061a4a7b9f75c3346` (CLI 0.16.2). The Go sources are
unchanged, including the `workspacesync` and `syncprotocol` regression tests.
The snapshot contains the five packages listed below, plus a minimal module
manifest; the only external module is the checksum-pinned `golang.org/x/sys`.
This keeps source builds independent of access to the private platform repository.

- `fire-fuse/workspacesync`
- `fire-fuse/syncprotocol`
- `fire-fuse/runtime/model`
- `fire-fuse/runtime/sandboxprofile`
- `fire-fuse/messageprotocol`

When refreshing, copy non-test Go sources from these packages at the selected
platform commit, along with the `workspacesync` and `syncprotocol` tests. Update
the required platform version in `go.mod` and the revision above, run `go mod tidy`,
and review the snapshot diff. Keep the local `replace ... => ./platform` directive.
Do not put a local checkout path or platform credentials in a release build.

Run the adapter and copied filesystem regression tests with:

```sh
cd native
go test ./... github.com/stepandel/cantelop/fire-fuse/workspacesync github.com/stepandel/cantelop/fire-fuse/syncprotocol
```

The adapter's pipe and loopback protocol matches the existing CLI adapter. The
CLI command remains available for older SDK releases. Hosted routes, baseline
formats, directory confinement, locking, publication, and write gates are unchanged.
