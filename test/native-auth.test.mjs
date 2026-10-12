import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

async function loadClaudeAuth() {
  const output = await build({ entryPoints: [new URL("../examples/anthropic/src/auth.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false });
  return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`)).ClaudeAuth;
}

test("stock Claude login challenge, code submission, status and logout use Workspace native state", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "cantelop-native-auth-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const binary = join(workspace, "fake-claude");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const state = path.join(process.env.CLAUDE_CONFIG_DIR, 'fixture-auth');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, {recursive:true});
const op = process.argv.slice(2).join(' ');
if (op === 'auth status') { console.log(JSON.stringify({loggedIn:fs.existsSync(state)})); process.exit(0); }
if (op === 'auth logout') { fs.rmSync(state,{force:true}); process.exit(0); }
if (op !== 'auth login') process.exit(2);
console.log('Open https://claude.ai/oauth/authorize?fixture=1 ');
console.log('Paste code:');
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  if (text.trim() === 'good-code') { fs.writeFileSync(state,'ok'); process.exit(0); }
  console.log('Paste code:');
});
`, { mode: 0o755 });
  const ClaudeAuth = await loadClaudeAuth();
  const helper = new URL("../examples/anthropic/runtime/login-pty.py", import.meta.url).pathname;
  const auth = new ClaudeAuth(workspace, binary, helper);
  assert.deepEqual(await auth.handle({ type: "methods" }), { type: "methods", methods: ["browser-code"] });
  assert.deepEqual(await auth.handle({ type: "status" }), { type: "status", authenticated: false });
  const login = await auth.handle({ type: "login", method: "browser-code" });
  assert.equal(login.type, "login");
  assert.match(login.url, /^https:\/\/claude\.ai\//);
  assert.equal((await auth.handle({ type: "login", method: "browser-code" })).attemptId, login.attemptId);
  assert.deepEqual(await auth.handle({ type: "submit", attemptId: login.attemptId, code: "good-code" }),
    { type: "status", authenticated: true });
  assert.deepEqual(await auth.handle({ type: "logout" }), { type: "status", authenticated: false });
  const second = await auth.handle({ type: "login", method: "browser-code" });
  assert.notEqual(second.attemptId, login.attemptId);
  assert.deepEqual(await auth.handle({ type: "cancel", attemptId: second.attemptId }),
    { type: "cancelled", attemptId: second.attemptId });
  await assert.rejects(auth.handle({ type: "submit", attemptId: second.attemptId, code: "good-code" }), /not active/);
});
