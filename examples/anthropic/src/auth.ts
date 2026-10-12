import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { nativeEnvironment } from "../../native-harness/cli.js";
import type { AppAuth, AuthContext } from "@cantelop/sdk/session";

const exec = promisify(execFile);

function native(context: AuthContext) {
  const workspace = process.cwd();
  return { workspace, binary: context.env.CLAUDE_PATH ?? "/usr/local/bin/claude", env: nativeEnvironment(workspace) };
}

/**
 * Stock `claude auth` commands. The user signs in inside the CLI's own terminal;
 * this provider never sees the sign-in code or the credentials the CLI stores.
 */
export const claudeAuth: AppAuth = {
  async status(context) {
    const { workspace, binary, env } = native(context);
    let stdout: string;
    try {
      ({ stdout } = await exec(binary, ["auth", "status"], { cwd: workspace, env, timeout: 15_000, maxBuffer: 65_536 }));
    } catch (error) {
      // Signed-out status exits non-zero but still reports JSON.
      const failure = error as { stdout?: string; killed?: boolean; signal?: string };
      if (failure.killed || failure.signal || !failure.stdout) throw new Error("Claude auth status unavailable");
      stdout = failure.stdout;
    }
    let status: unknown;
    try { status = JSON.parse(stdout); } catch { throw new Error("Claude auth status unavailable"); }
    const loggedIn = (status as { loggedIn?: unknown } | null)?.loggedIn;
    if (typeof loggedIn !== "boolean") throw new Error("Claude auth status unavailable");
    return loggedIn;
  },
  async logout(context) {
    const { workspace, binary, env } = native(context);
    try { await exec(binary, ["auth", "logout"], { cwd: workspace, env, timeout: 15_000, maxBuffer: 65_536 }); }
    catch { throw new Error("Claude logout failed"); }
  },
  terminal(context) {
    const { workspace, binary, env } = native(context);
    const helper = context.env.CLAUDE_LOGIN_HELPER ?? "/opt/app/login-pty.py";
    // All of the CLI's sign-in methods stay available; BROWSER is a no-op because the user's own browser opens the link.
    const child = spawn("python3", ["-u", helper, binary, "auth", "login"], {
      cwd: workspace, env: { ...env, TERM: "xterm-256color", BROWSER: "/bin/true" }, stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    const control = child.stdio[3] as NodeJS.WritableStream;
    control.on("error", () => undefined);
    return Object.assign(child, { resize(columns: number, rows: number) { control.write(`${columns} ${rows}\n`); } });
  },
};
