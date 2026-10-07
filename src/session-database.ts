/// <reference types="node" />
import { createWorkspaceDatabase, DatabaseAccessError, validateLocalDatabaseOrigin, type WorkspaceDatabase } from "./database.js";
import type { SessionEnvironment } from "./session.js";
/** Works before the first message and can supply credentials to native clients. */
export function createSessionDatabase(environment: SessionEnvironment = process.env, request: typeof fetch = fetch, options: { intMode?: "number" | "bigint" | "string" } = {}): WorkspaceDatabase {
  const localDatabaseOrigin = environment.CANTELOP_LOCAL_DATABASE_ORIGIN;
  return createWorkspaceDatabase(async () => {
    const endpoint = environment.CANTELOP_WORKSPACE_DATABASE_CREDENTIALS_URL;
    const token = environment.CANTELOP_WORKSPACE_DATABASE_ACCESS_TOKEN;
    if (!endpoint || !token) throw new DatabaseAccessError("runtime_not_configured");
    const url = new URL(endpoint);
    const local = localDatabaseOrigin !== undefined && url.origin === validateLocalDatabaseOrigin(localDatabaseOrigin).origin;
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/internal/v1/runtime/database/credentials") throw new DatabaseAccessError("invalid_runtime_configuration");
    let response: Response;
    try {
      response = await request(url, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    } catch { throw new DatabaseAccessError("credentials_unavailable"); }
    if (!response.ok) throw new DatabaseAccessError("credentials_unavailable");
    try {
      const document = await response.text();
      if (document.length > 32768) throw new Error();
      return JSON.parse(document);
    } catch { throw new DatabaseAccessError("invalid_credentials"); }
  }, { localDatabaseOrigin, ...options });
}
