import { WorkspaceSyncError, type WorkspaceSyncOptions, type WorkspaceSync } from "./sync.js";
export async function startSync(_options: WorkspaceSyncOptions, _workspaceId: string, _fetch: (request: Request) => Promise<Response>): Promise<WorkspaceSync> {
  throw new WorkspaceSyncError("sync_requires_node");
}
