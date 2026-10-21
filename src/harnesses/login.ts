/// <reference types="node" />
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { AuthContext, AuthTerminalProcess } from "../session.js";
import { nativeEnvironment, type NativeEnvironmentHook } from "./cli.js";

const exec = promisify(execFile);

/**
 * The Workspace and stock binary every native auth command runs against. Pass the
 * provider's environment hook so auth commands see the same configuration
 * directories as its turns.
 */
export function nativeAuth(context: AuthContext, binaryVariable: string, defaultBinary: string, environment?: NativeEnvironmentHook) {
  const workspace = process.cwd();
  return { workspace, binary: context.env[binaryVariable] ?? defaultBinary, env: nativeEnvironment(workspace, environment) };
}

/** Runs a non-interactive auth command; signed-out commands exit non-zero but still report. */
export async function runAuthCommand(binary: string, args: string[], options: { workspace: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(binary, args, { cwd: options.workspace, env: options.env, timeout: 15_000, maxBuffer: 65_536 });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; killed?: boolean; signal?: string };
    if (failure.killed || failure.signal || typeof failure.code !== "number") throw new Error(`${args.join(" ")} unavailable`);
    return { code: failure.code, stdout: failure.stdout ?? "" };
  }
}

/**
 * Spawns the stock CLI's interactive login inside a PTY (`login-pty.py`), so the user's
 * browser terminal shows exactly what the CLI renders. Resizes travel on fd 3.
 */
export async function loginTerminal(context: AuthContext, binary: string, args: string[], options: { workspace: string; env: NodeJS.ProcessEnv; directories?: string[] }) {
  for (const directory of options.directories ?? []) await mkdir(directory, { recursive: true, mode: 0o700 });
  const helper = context.env.LOGIN_PTY_HELPER ?? "/opt/app/login-pty.py";
  // BROWSER is a no-op: the user opens sign-in links in their own browser.
  const child = spawn("python3", ["-u", helper, binary, ...args], {
    cwd: options.workspace, env: { ...options.env, TERM: "xterm-256color", BROWSER: "/bin/true" }, stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
  const control = child.stdio[3] as NodeJS.WritableStream;
  control.on("error", () => undefined);
  return Object.assign(child, { resize(columns: number, rows: number) { control.write(`${columns} ${rows}\n`); } }) satisfies AuthTerminalProcess;
}
