import { loginTerminal, nativeAuth, runAuthCommand } from "@cantelop/sdk/harnesses/native";
import type { AppAuth, AuthContext } from "@cantelop/sdk/session";
import { CODEX_BINARY, codexEnvironment } from "./environment.ts";

/** The stock binary and Workspace environment every Codex auth command runs with. */
const codex = (context: AuthContext) => nativeAuth(context, "CODEX_PATH", CODEX_BINARY, codexEnvironment);

/**
 * Stock `codex login` with device-code sign-in: the CLI shows a link and a one-time
 * code that the user enters on OpenAI's own page, then the CLI completes by itself.
 * Device-code login must be enabled in the user's ChatGPT security settings.
 */
export const codexAuth: AppAuth = {
  async status(context) {
    const { binary, ...options } = codex(context);
    const { code } = await runAuthCommand(binary, ["login", "status"], options);
    if (code > 1) throw new Error("Codex login status unavailable");
    return code === 0;
  },
  async logout(context) {
    const { binary, ...options } = codex(context);
    // Logging out a signed-out Workspace is not an error; status reports the result.
    await runAuthCommand(binary, ["logout"], options);
  },
  terminal(context) {
    const { binary, ...options } = codex(context);
    return loginTerminal(context, binary, ["login", "--device-auth"], { ...options, directories: [options.env.CODEX_HOME!] });
  },
};
