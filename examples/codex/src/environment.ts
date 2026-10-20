import type { NativeEnvironmentHook } from "@cantelop/sdk/harnesses/native";

/** Stock CLI location in the example image; the CODEX_PATH setting overrides it. */
export const CODEX_BINARY = "/usr/local/bin/codex";

/** Codex auth and config live in the Workspace; its live SQLite stays in the local cache. */
export const codexEnvironment: NativeEnvironmentHook = (env, workspace) => ({
  CODEX_HOME: `${workspace}/.codex`,
  CODEX_SQLITE_HOME: `${env.XDG_CACHE_HOME}/codex-sqlite`,
});
