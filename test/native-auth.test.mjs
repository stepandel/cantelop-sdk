import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createSessionRuntimeHandler } from "../dist/runtime.js";
import { bridgeAuthTerminal } from "../dist/build.js";

const sandboxId = "sbx-" + "c".repeat(32);
const protocol = "cantelop-terminal.v1";

async function loadAuth(example) {
  const output = await build({ entryPoints: [new URL(`../examples/${example}/src/auth.ts`, import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
}
const helper = new URL("../dist/harnesses/claude/login-pty.py", import.meta.url).pathname;

/** A temporary Workspace as the process cwd, with an executable fake stock CLI. */
async function workspaceWith(t, name, source) {
  const workspace = await mkdtemp(join(tmpdir(), "cantelop-native-auth-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const previous = process.cwd();
  process.chdir(workspace);
  t.after(() => process.chdir(previous));
  const binary = join(workspace, name);
  await writeFile(binary, source, { mode: 0o755 });
  return { workspace, binary };
}

async function settle(runtime) {
  for (const deadline = Date.now() + 5000; !await runtime.quiescent();) {
    if (Date.now() > deadline) assert.fail("auth runtime stayed active after the login exited");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `127.0.0.1:${server.address().port}`;
}

/** Sandbox runtime plus a stand-in platform that terminates the browser WebSocket with the SDK bridge. */
async function authRuntime(t, auth, env) {
  const base = await listen(t, createServer(createSessionRuntimeHandler({ create: () => assert.fail("auth must not create a harness") }, { sandboxId, auth, env })));
  let next = 0x900;
  const fetch = (path, init = {}) => globalThis.fetch(`http://${base}${path}`, { ...init, headers: { "X-Cantelop-Sandbox-ID": sandboxId, ...init.headers } });
  const platform = createServer((request, response) => { response.statusCode = 404; response.end(); });
  platform.on("upgrade", (request, socket, head) => {
    const terminalId = /\/terminals\/([^/?]+)/.exec(request.url)?.[1] ?? "";
    void bridgeAuthTerminal(request, socket, head, terminalId, { fetch: (path, init) => fetch(path, init) });
  });
  const platformBase = await listen(t, platform);
  return {
    async command(auth) {
      const id = `msg_${(next++).toString(16).padStart(32, "0")}`;
      const response = await fetch("/__cantelop/v2/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        session: { id: "cantelop-native-auth", workspace_id: "wsp_" + "d".repeat(32), keep_alive_seconds: 300 },
        message: { id, payload: { __cantelop_command: 2, type: "auth", auth } }, reply: true,
      }) });
      assert.equal(response.status, 202, await response.text());
      for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
        const status = await (await fetch(`/__cantelop/v2/messages/${id}`)).json();
        if (status.state === "succeeded") return (await (await fetch(`/__cantelop/v2/messages/${id}/reply`)).json()).reply;
        if (["failed", "timed_out"].includes(status.state)) throw new Error(`auth command ${status.state}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("auth command timed out");
    },
    async quiescent() { return (await (await fetch("/__cantelop/v2/runtime")).json()).quiescent; },
    sandbox: fetch, base,
    connect(terminalId, protocols) {
      const socket = new WebSocket(`ws://${platformBase}/terminals/${terminalId}`, protocols);
      socket.binaryType = "arraybuffer";
      let text = "";
      const waiters = new Set();
      const notify = () => { for (const waiter of [...waiters]) waiter(); };
      socket.onmessage = event => { text += Buffer.from(event.data).toString("utf8"); notify(); };
      const opened = new Promise((resolve, reject) => { socket.onopen = () => resolve(socket.protocol); socket.onerror = () => reject(new Error("refused")); });
      const closed = new Promise(resolve => { socket.onclose = event => { notify(); resolve(event.code); }; });
      return {
        opened, closed,
        get text() { return text; },
        send(value) { socket.send(typeof value === "string" ? new TextEncoder().encode(value) : value); },
        control(value) { socket.send(JSON.stringify(value)); },
        close() { socket.close(); },
        until(pattern) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`terminal never printed ${pattern}: ${JSON.stringify(text)}`)); }, 10_000);
            const check = () => { if (pattern.test(text)) { clearTimeout(timer); waiters.delete(check); resolve(text); } };
            waiters.add(check); check();
          });
        },
      };
    },
  };
}

test("stock Claude sign-in completes in the CLI's own terminal; the runtime only relays bytes", async t => {
  const { binary } = await workspaceWith(t, "fake-claude", `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const state = path.join(process.env.CLAUDE_CONFIG_DIR, 'fixture-auth');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, {recursive:true});
const op = process.argv.slice(2).join(' ');
if (op === 'auth status') { console.log(JSON.stringify({loggedIn:fs.existsSync(state)})); process.exit(fs.existsSync(state) ? 0 : 1); }
if (op === 'auth logout') { fs.rmSync(state,{force:true}); process.exit(0); }
if (op !== 'auth login') process.exit(2);
process.stdout.on('resize', () => console.log('size ' + process.stdout.columns + 'x' + process.stdout.rows));
console.log('term ' + process.env.TERM + ' size ' + process.stdout.columns + 'x' + process.stdout.rows);
console.log('Open https://claude.ai/oauth/authorize?fixture=1');
console.log('Paste code here:');
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  if (text.trim() === 'good-code') { fs.writeFileSync(state,'ok'); console.log('Signed in'); process.exit(0); }
  console.log('Invalid code. Paste code here:');
});
`);
  const runtime = await authRuntime(t, (await loadAuth("anthropic")).claudeAuth, { CLAUDE_PATH: binary, LOGIN_PTY_HELPER: helper });
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: false });

  const terminal = await runtime.command({ type: "terminal" });
  assert.equal(terminal.type, "terminal");
  assert.match(terminal.terminalId, /^trm_[0-9a-f]{32}$/);
  assert.match(terminal.ticket, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(terminal.expiresAt) > Date.now());
  assert.equal(await runtime.quiescent(), false);

  // No ticket, a wrong ticket, or a missing Sandbox binding never reach the process.
  await assert.rejects(runtime.connect(terminal.terminalId, [protocol]).opened);
  await assert.rejects(runtime.connect(terminal.terminalId, [protocol, "0".repeat(64)]).opened);
  const attach = `/__cantelop/v2/runtime/auth/terminals/${terminal.terminalId}/attach`;
  assert.equal((await globalThis.fetch(`http://${runtime.base}${attach}`, { method: "POST", headers: { "X-Cantelop-Terminal-Ticket": terminal.ticket } })).status, 409);
  assert.equal((await runtime.sandbox(attach, { method: "POST" })).status, 401);
  assert.equal((await runtime.sandbox(`/__cantelop/v2/runtime/auth/terminals/${terminal.terminalId}/input`, { method: "POST", headers: { "X-Cantelop-Terminal-Ticket": terminal.ticket }, body: "early" })).status, 409);

  const user = runtime.connect(terminal.terminalId, [protocol, terminal.ticket]);
  assert.equal(await user.opened, protocol);
  // Output printed before the browser connected is delivered once it connects.
  await user.until(/Paste code here:/);
  assert.match(user.text, /term xterm-256color size 100x30/);
  assert.match(user.text, /https:\/\/claude\.ai\/oauth\/authorize\?fixture=1/);
  // The ticket is single-use.
  await assert.rejects(runtime.connect(terminal.terminalId, [protocol, terminal.ticket]).opened);

  user.control({ type: "resize", columns: 132, rows: 43 });
  await user.until(/size 132x43/);
  user.send("wrong-code\r");
  await user.until(/Invalid code/);
  user.send("good-code\r");
  await user.until(/Signed in/);
  assert.equal(await user.closed, 1000);
  await settle(runtime);
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: true });
  assert.deepEqual(await runtime.command({ type: "logout" }), { type: "status", authenticated: false });
});

test("stock Codex device-code sign-in finishes by itself after the user approves on OpenAI's page", async t => {
  const { workspace, binary } = await workspaceWith(t, "fake-codex", `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const state = path.join(process.env.CODEX_HOME, 'auth.json');
const op = process.argv.slice(2).join(' ');
if (op === 'login status') { console.log(fs.existsSync(state) ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(fs.existsSync(state) ? 0 : 1); }
if (op === 'logout') { fs.rmSync(state, {force:true}); process.exit(0); }
if (op !== 'login --device-auth') process.exit(2);
console.log('tty ' + process.stdout.isTTY);
console.log('Open https://auth.openai.com/codex/device and enter code ABCD-1234');
// The user approves on OpenAI's page; the CLI's own polling then completes.
setTimeout(() => { fs.writeFileSync(state, '{}'); console.log('Successfully logged in'); process.exit(0); }, 200);
`);
  const runtime = await authRuntime(t, (await loadAuth("codex")).codexAuth, { CODEX_PATH: binary, LOGIN_PTY_HELPER: helper });
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: false });
  const terminal = await runtime.command({ type: "terminal" });
  const user = runtime.connect(terminal.terminalId, [protocol, terminal.ticket]);
  await user.opened;
  await user.until(/Successfully logged in/);
  assert.match(user.text, /tty true/);
  assert.match(user.text, /enter code ABCD-1234/);
  assert.equal(await user.closed, 1000);
  await settle(runtime);
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: true });
  // Credentials land in the Workspace's CODEX_HOME, owned by the stock CLI.
  await (await import("node:fs/promises")).access(join(workspace, ".codex", "auth.json"));
  assert.deepEqual(await runtime.command({ type: "logout" }), { type: "status", authenticated: false });
});

test("stock OpenCode sign-in is pinned to one allowed provider and never offers Anthropic", async t => {
  const { workspace, binary } = await workspaceWith(t, "fake-opencode", `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'logout') { const all = read(); delete all[args[2]]; fs.writeFileSync(file, JSON.stringify(all)); process.exit(0); }
if (args.join(' ') !== 'auth login --provider openrouter') { console.log('unexpected ' + args.join(' ')); process.exit(2); }
console.log('Enter your API key');
process.stdin.setEncoding('utf8');
process.stdin.on('data', key => { const all = read(); all.openrouter = { type: 'api', key: key.trim() }; fs.writeFileSync(file, JSON.stringify(all)); console.log('Done'); process.exit(0); });
`);
  const { opencodeAuth, OPENCODE_LOGIN_PROVIDERS } = await loadAuth("opencode");
  assert.equal(OPENCODE_LOGIN_PROVIDERS.includes("anthropic"), false);
  const denied = await authRuntime(t, opencodeAuth, { OPENCODE_PATH: binary, LOGIN_PTY_HELPER: helper, OPENCODE_LOGIN_PROVIDER: "anthropic" });
  await assert.rejects(denied.command({ type: "terminal" }), /failed/);
  const runtime = await authRuntime(t, opencodeAuth, { OPENCODE_PATH: binary, LOGIN_PTY_HELPER: helper, OPENCODE_LOGIN_PROVIDER: "openrouter" });
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: false });
  const terminal = await runtime.command({ type: "terminal" });
  const user = runtime.connect(terminal.terminalId, [protocol, terminal.ticket]);
  await user.opened;
  await user.until(/Enter your API key/);
  user.send("sk-user-own-key\r");
  await user.until(/Done/);
  assert.equal(await user.closed, 1000);
  await settle(runtime);
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: true });
  // The key lands in OpenCode's own Workspace file, where the harness links it from.
  assert.ok(JSON.parse(await (await import("node:fs/promises")).readFile(join(workspace, ".local", "share", "opencode", "auth.json"), "utf8")).openrouter);
  assert.deepEqual(await runtime.command({ type: "logout" }), { type: "status", authenticated: false });
});

test("every example image ships the same login PTY helper", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = example => readFile(new URL(`../examples/${example}/runtime/login-pty.py`, import.meta.url), "utf8");
  const reference = await readFile(new URL("../dist/harnesses/claude/login-pty.py", import.meta.url), "utf8");
  for (const example of ["codex", "opencode"]) {
    assert.equal(await read(example), reference, `${example}/runtime/login-pty.py differs from the anthropic copy`);
    assert.match(await readFile(new URL(`../examples/${example}/docker/Dockerfile`, import.meta.url), "utf8"), /COPY runtime\/login-pty\.py \/opt\/app\/login-pty\.py/);
  }
});

test("closing the browser, an explicit close, or a newer terminal ends an unfinished login", async t => {
  const processes = [];
  const auth = {
    status: () => false, logout() {},
    async terminal() {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); process.stdin.pipe(process.stdout); setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "ignore"] });
      const exited = new Promise(resolve => child.once("close", resolve));
      processes.push(exited);
      return child;
    },
  };
  const runtime = await authRuntime(t, auth, {});
  const first = await runtime.command({ type: "terminal" });
  const user = runtime.connect(first.terminalId, [protocol, first.ticket]);
  await user.opened;
  await user.until(/ready/);
  user.send("echoed\n");
  await user.until(/echoed/);
  user.close();
  await processes[0];

  const second = await runtime.command({ type: "terminal" });
  const third = await runtime.command({ type: "terminal" });
  await processes[1];
  await assert.rejects(runtime.connect(second.terminalId, [protocol, second.ticket]).opened);
  assert.deepEqual(await runtime.command({ type: "close", terminalId: third.terminalId }), { type: "closed", terminalId: third.terminalId });
  await processes[2];
  for (const deadline = Date.now() + 5000; !await runtime.quiescent();) {
    if (Date.now() > deadline) assert.fail("auth runtime stayed active");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});
