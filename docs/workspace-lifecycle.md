# Workspace inspection and deletion

`workspace.resolve()` opens or provisions a Workspace. Use `inspect()` when a
read must not create one:

```ts
const selected = app.workspace({ slug: "my-project" });
const existing = await selected.inspect({ signal }); // Workspace | undefined
if (existing) {
  // Confirm this exact identity in your UI, then delete it by ID.
  const deletion = await app.workspace({ id: existing.id }).delete({ signal });
  console.log(deletion?.status); // "deleting"
}
```

Both calls use the App's SDK connection and integration credentials. They do
not require the Cantelop CLI, account login, Claude login, or a Session Sandbox.
App integration credentials authorize deletion of Workspaces within that App.
The caller's App scope comes from trusted platform routing.

Inspection returns `undefined` for an absent, archived, or inaccessible
Workspace. Infrastructure failures propagate. It does not cache a slug lookup.
Deleting a slug inspects it first and pins the resulting ID; deleting an absent
slug returns `undefined`. Use an explicit ID after user confirmation to keep a
replacement with the same slug safe. Repeated ID deletions can retry a failed
purge without targeting that replacement.

Deletion stops Sessions and permanently purges all remote files and database
data, including agent credentials and uncommitted edits. It does not change
local project files. Preserve remote work before deleting. SDK methods do not
prompt; the calling application owns confirmation.

The result is `{ id, status: "deleting", hostArchived }`. `hostArchived` means
the compute host no longer admits work for that identity; filesystem and
database purge may still be pending. A successful call invalidates that
reference's cached `resolve()` result. Other references and running clients
must handle deletion independently.

Deploy platform support for the two commands and rebuild the App Edge with
this SDK before using them. They bypass Session runtime compatibility checks.
Local `cantelop dev` supports inspection; deletion returns
`workspace_deletion_unavailable_in_local_dev` because it has no managed purge
coordinator.
