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

async function loadClaudeAuth() {
  const output = await build({ entryPoints: [new URL("../examples/anthropic/src/auth.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false });
  return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`)).claudeAuth;
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
  const workspace = await mkdtemp(join(tmpdir(), "cantelop-native-auth-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const previous = process.cwd();
  process.chdir(workspace);
  t.after(() => process.chdir(previous));
  const binary = join(workspace, "fake-claude");
  await writeFile(binary, `#!/usr/bin/env node
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
`, { mode: 0o755 });
  const runtime = await authRuntime(t, await loadClaudeAuth(), {
    CLAUDE_PATH: binary, CLAUDE_LOGIN_HELPER: new URL("../examples/anthropic/runtime/login-pty.py", import.meta.url).pathname,
  });
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
  for (const deadline = Date.now() + 5000; !await runtime.quiescent();) {
    if (Date.now() > deadline) assert.fail("auth runtime stayed active after the login exited");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await runtime.command({ type: "status" }), { type: "status", authenticated: true });
  assert.deepEqual(await runtime.command({ type: "logout" }), { type: "status", authenticated: false });
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
