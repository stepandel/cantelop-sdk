import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function buildHarnessAssets() {
  const destination = new URL("../dist/harnesses/claude/", import.meta.url);
  const helper = await readFile(new URL("../assets/login-pty.py", import.meta.url));
  const template = await readFile(new URL("../assets/claude/Dockerfile", import.meta.url), "utf8");
  await mkdir(destination, { recursive: true });
  await writeFile(new URL("Dockerfile", destination), template.replace("__LOGIN_PTY_BASE64__", helper.toString("base64")));
  await writeFile(new URL("login-pty.py", destination), helper);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildHarnessAssets();
