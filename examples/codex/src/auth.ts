import { loginTerminal, nativeAuth, runAuthCommand } from "../../native-harness/login.ts";
import type { AppAuth } from "@cantelop/sdk/session";

/**
 * Stock `codex login` with device-code sign-in: the CLI shows a link and a one-time
 * code that the user enters on OpenAI's own page, then the CLI completes by itself.
 * Device-code login must be enabled in the user's ChatGPT security settings.
 */
export const codexAuth: AppAuth = {
  async status(context) {
    const { binary, ...options } = nativeAuth(context, "CODEX_PATH", "/usr/local/bin/codex");
    const { code } = await runAuthCommand(binary, ["login", "status"], options);
    if (code > 1) throw new Error("Codex login status unavailable");
    return code === 0;
  },
  async logout(context) {
    const { binary, ...options } = nativeAuth(context, "CODEX_PATH", "/usr/local/bin/codex");
    // Logging out a signed-out Workspace is not an error; status reports the result.
    await runAuthCommand(binary, ["logout"], options);
  },
  terminal(context) {
    const { binary, ...options } = nativeAuth(context, "CODEX_PATH", "/usr/local/bin/codex");
    return loginTerminal(context, binary, ["login", "--device-auth"], { ...options, directories: [options.env.CODEX_HOME!] });
  },
};
