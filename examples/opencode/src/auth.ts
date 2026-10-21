import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loginTerminal, nativeAuth, runAuthCommand } from "@cantelop/sdk/harnesses/native";
import type { AppAuth, AuthContext } from "@cantelop/sdk/session";
import { OPENCODE_BINARY } from "./environment.ts";

/**
 * Providers this App lets users sign in to. Keep each one only after confirming its
 * terms allow hosted use. Anthropic is excluded: Claude subscription sign-in through
 * third-party tools is not permitted (use the Claude Code example instead).
 */
export const OPENCODE_LOGIN_PROVIDERS = ["opencode", "openai", "openrouter", "vercel", "google"] as const;

function provider(context: AuthContext): string {
  const value = context.env.OPENCODE_LOGIN_PROVIDER ?? "opencode";
  if (!(OPENCODE_LOGIN_PROVIDERS as readonly string[]).includes(value)) throw new Error(`OpenCode login provider not allowed: ${value}`);
  return value;
}

/** The stock binary and Workspace environment every OpenCode auth command runs with. */
const opencode = (context: AuthContext) => nativeAuth(context, "OPENCODE_PATH", OPENCODE_BINARY);

/** Stock `opencode auth`, pinned to one allowed provider; credentials stay in OpenCode's own file. */
export const opencodeAuth: AppAuth = {
  async status(context) {
    const { env } = opencode(context);
    let credentials: unknown;
    try { credentials = JSON.parse(await readFile(join(env.XDG_DATA_HOME!, "opencode", "auth.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("OpenCode credentials unavailable");
    }
    // Only the provider's presence is checked; credential values are never used.
    return !!credentials && typeof credentials === "object" && Object.hasOwn(credentials, provider(context));
  },
  async logout(context) {
    const { binary, ...options } = opencode(context);
    await runAuthCommand(binary, ["auth", "logout", provider(context)], options);
  },
  terminal(context) {
    const { binary, ...options } = opencode(context);
    return loginTerminal(context, binary, ["auth", "login", "--provider", provider(context)], { ...options, directories: [join(options.env.XDG_DATA_HOME!, "opencode")] });
  },
};
