import { loginTerminal, nativeAuth, runAuthCommand } from "../../native-harness/login.ts";
import type { AppAuth } from "@cantelop/sdk/session";

/**
 * Stock `claude auth` commands. The user signs in inside the CLI's own terminal;
 * this provider never sees the sign-in code or the credentials the CLI stores.
 */
export const claudeAuth: AppAuth = {
  async status(context) {
    const { binary, ...options } = nativeAuth(context, "CLAUDE_PATH", "/usr/local/bin/claude");
    // Signed-out status exits non-zero but still reports JSON.
    const { stdout } = await runAuthCommand(binary, ["auth", "status"], options);
    let status: unknown;
    try { status = JSON.parse(stdout); } catch { throw new Error("Claude auth status unavailable"); }
    const loggedIn = (status as { loggedIn?: unknown } | null)?.loggedIn;
    if (typeof loggedIn !== "boolean") throw new Error("Claude auth status unavailable");
    return loggedIn;
  },
  async logout(context) {
    const { binary, ...options } = nativeAuth(context, "CLAUDE_PATH", "/usr/local/bin/claude");
    if ((await runAuthCommand(binary, ["auth", "logout"], options)).code !== 0) throw new Error("Claude logout failed");
  },
  terminal(context) {
    const { binary, ...options } = nativeAuth(context, "CLAUDE_PATH", "/usr/local/bin/claude");
    // All of the CLI's sign-in methods stay available.
    return loginTerminal(context, binary, ["auth", "login"], options);
  },
};
