import { mkdir, readFile, writeFile } from "node:fs/promises";

const helper = await readFile(new URL("../assets/claude/login-pty.py", import.meta.url));
for (const provider of ["claude", "codex"]) {
  const source = new URL(`../assets/${provider}/`, import.meta.url);
  const destination = new URL(`../dist/harnesses/${provider}/`, import.meta.url);
  const template = await readFile(new URL("Dockerfile", source), "utf8");
  await mkdir(destination, { recursive: true });
  await writeFile(new URL("Dockerfile", destination), template.replace("__LOGIN_PTY_BASE64__", helper.toString("base64")));
  await writeFile(new URL("login-pty.py", destination), helper);
}
