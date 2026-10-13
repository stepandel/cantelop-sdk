import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../assets/claude/", import.meta.url);
const destination = new URL("../dist/harnesses/claude/", import.meta.url);
const helper = await readFile(new URL("login-pty.py", source));
const template = await readFile(new URL("Dockerfile", source), "utf8");
await mkdir(destination, { recursive: true });
await writeFile(new URL("Dockerfile", destination), template.replace("__LOGIN_PTY_BASE64__", helper.toString("base64")));
await writeFile(new URL("login-pty.py", destination), helper);
