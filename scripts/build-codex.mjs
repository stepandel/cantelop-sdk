#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile, access, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_REVISION = "24edd7b89026865149d58d0a090694a2146b6d3c";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`); return resolve(args[index + 1]); }
const source = option("--source", join(root, "native", "build", "codex"));
const output = option("--output", join(root, "native", "bin", process.platform === "win32" ? "cantelop-codex.exe" : "cantelop-codex"));
const patchPath = join(root, "native", "upstream.patch");
const patch = await readFile(patchPath);
const fingerprint = createHash("sha256").update(patch);
async function hashTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    fingerprint.update(entry.name);
    if (entry.isDirectory()) await hashTree(join(directory, entry.name));
    else fingerprint.update(await readFile(join(directory, entry.name)));
  }
}
for (const file of ["Cargo.toml", "schema-map.json"]) fingerprint.update(await readFile(join(root, "native", "codex-workspace", file)));
await hashTree(join(root, "native", "codex-workspace", "src"));
const identity = `${CODEX_REVISION}:${fingerprint.digest("hex")}`;
const marker = join(source, ".cantelop-native-build");
async function run(command, argv, cwd, capture = false, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { cwd, env, shell: false, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let stdout = "";
    if (capture) child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`${command} exited with code ${code}`)));
  });
}
let exists = false;
try { await access(source); exists = true; } catch { }
if (!exists) {
  await mkdir(source, { recursive: true });
  await run("git", ["init", "--quiet"], source);
  await run("git", ["remote", "add", "origin", "https://github.com/openai/codex.git"], source);
  await run("git", ["fetch", "--depth=1", "origin", CODEX_REVISION], source);
  await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
} else {
  const head = await run("git", ["rev-parse", "HEAD"], source, true);
  if (head !== CODEX_REVISION) throw new Error("Source checkout does not match the pinned Codex revision");
}
let prepared = false;
try { prepared = (await readFile(marker, "utf8")).trim() === identity; } catch { }
if (!prepared) {
  const changes = await run("git", ["status", "--porcelain"], source, true);
  if (changes) throw new Error("Refusing to overwrite a modified source checkout; use a fresh --source directory");
  await run("git", ["apply", "--check", patchPath], source);
  await run("git", ["apply", patchPath], source);
  const driver = join(source, "codex-rs", "cantelop-workspace");
  await mkdir(driver, { recursive: true });
  for (const entry of ["Cargo.toml", "schema-map.json", "src"]) await cp(join(root, "native", "codex-workspace", entry), join(driver, entry), { recursive: true });
  await writeFile(marker, `${identity}\n`);
}
// A preparation marker must not silently authorize later edits to the native fork.
const actualPatch = await run("git", ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-color", "--diff-algorithm=myers", "--unified=3"], source, true);
if (actualPatch !== patch.toString("utf8").trim()) throw new Error("Prepared Codex sources have changed; use a fresh --source directory");
async function verifyDriver(directory, reference) {
  for (const entry of await readdir(reference, { withFileTypes: true })) {
    if (entry.isDirectory()) await verifyDriver(join(directory, entry.name), join(reference, entry.name));
    else if (!(await readFile(join(directory, entry.name))).equals(await readFile(join(reference, entry.name)))) throw new Error("Prepared workspace driver has changed");
  }
}
const preparedDriver = join(source, "codex-rs", "cantelop-workspace");
for (const file of ["Cargo.toml", "schema-map.json"]) {
  if (!(await readFile(join(preparedDriver, file))).equals(await readFile(join(root, "native", "codex-workspace", file)))) throw new Error("Prepared workspace driver has changed");
}
await verifyDriver(join(preparedDriver, "src"), join(root, "native", "codex-workspace", "src"));
if (args.includes("--prepare-only")) { console.log(`Prepared Codex ${CODEX_REVISION} at ${source}`); process.exit(0); }
const rustup = process.env.CANTELOP_RUSTUP ?? "rustup";
const rustc = await run(rustup, ["which", "--toolchain", "1.95.0", "rustc"], root, true);
const rustdoc = await run(rustup, ["which", "--toolchain", "1.95.0", "rustdoc"], root, true);
await run(process.env.CANTELOP_CARGO ?? "cargo", ["+1.95.0", "build", "--release", "--locked", "-p", "codex-app-server", "--bin", "codex-app-server"], join(source, "codex-rs"), false, { ...process.env, RUSTC: rustc, RUSTDOC: rustdoc });
await mkdir(dirname(output), { recursive: true });
await cp(join(source, "codex-rs", "target", "release", process.platform === "win32" ? "codex-app-server.exe" : "codex-app-server"), output);
console.log(`Built ${output}`);
