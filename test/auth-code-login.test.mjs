import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthCodeLogin } from "../dist/auth-code-login.js";
import { claudeAuth } from "../dist/harnesses/claude.js";
import { codexAuth } from "../dist/harnesses/codex.js";
import { AuthTerminals } from "../dist/auth-terminal.js";
async function fixture(t,source,wait=500,lifetime=5_000){
  const workspace=await mkdtemp(join(tmpdir(),"sdk-code-login-"));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const file=join(workspace,"signed-in");const processes=[];const controller=new AbortController();
  const auth={codeLogin:claudeAuth.codeLogin,status:()=>existsSync(file),logout:()=>rm(file,{force:true}),terminal(){
    const child=spawn(process.execPath,["-e",source??`const fs=require('node:fs');console.log('Open https://claude.ai/oauth/authorize?test=1');console.log('Paste code:');process.stdin.setEncoding('utf8');process.stdin.on('data',code=>{if(code.trim()==='good'){fs.writeFileSync(process.argv[1],'ok');process.exit(0);}console.log('Invalid code. Paste code:');});`,file],{stdio:["pipe","pipe","ignore"]});processes.push(child);return child;
  }};
  const context={signal:controller.signal,session:{id:"cantelop-native-auth"},env:{}};
  const login=new AuthCodeLogin(auth,auth.codeLogin,context,()=>{},wait,lifetime);
  t.after(()=>login.stop());return {login,auth,context,processes,file,controller};
}
test("SDK extracts only an allowed native link, retries rejected codes and confirms CLI sign-in",async t=>{
  const {login,processes}=await fixture(t);
  const started=await login.login();assert.equal(started.type,"login");assert.match(started.attemptId,/^lgn_/);assert.equal(started.url,"https://claude.ai/oauth/authorize?test=1");
  assert.equal("ticket" in started,false);assert.equal("output" in started,false);assert.equal(login.active,true);
  assert.deepEqual(await login.login(),started);assert.equal(processes.length,1);
  assert.deepEqual(await login.code(started.attemptId,"wrong"),{type:"error",code:"code_rejected"});
  assert.deepEqual(await login.code(started.attemptId,"good"),{type:"status",authenticated:true});assert.equal(login.active,false);
  assert.deepEqual(await login.login(),{type:"status",authenticated:true});
});
test("cancel isolates attempts and forced reconnect clears old credentials before starting another CLI",async t=>{
  const {login,processes,file}=await fixture(t);await writeFile(file,"stale");
  assert.deepEqual(await login.login(),{type:"status",authenticated:true});assert.equal(processes.length,0);
  const started=await login.login(true);assert.equal(existsSync(file),false);assert.equal(processes.length,1);
  await login.cancel("lgn_"+"0".repeat(32));assert.equal(login.active,true);
  await login.cancel(started.attemptId);assert.equal(login.active,false);
  assert.deepEqual(await login.code(started.attemptId,"good"),{type:"error",code:"login_not_active"});
});
test("auth runtime handles structured commands and counts a pending native login in quiescence",async t=>{
  const {auth,context}=await fixture(t);const runtime=new AuthTerminals(auth,{},context.signal,()=>{});
  t.after(()=>runtime.handle({type:"logout"},context.session));
  const started=await runtime.handle({type:"login"},context.session);assert.equal(started.type,"login");assert.equal(runtime.active,true);
  assert.deepEqual(await runtime.handle({type:"code",attemptId:started.attemptId,code:"good"},context.session),{type:"status",authenticated:true});assert.equal(runtime.active,false);
});
test("expired, failed, oversized or link-less login output cannot leave an active process",async t=>{
  for(const source of ["console.log('https://evil.example/');setInterval(()=>{},1000)","process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)","process.exit(1)"]){
    const {login}=await fixture(t,source,100);assert.deepEqual(await login.login(),{type:"error",code:"login_failed"});assert.equal(login.active,false);
  }
  const {login}=await fixture(t,undefined,500,100);const started=await login.login();
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(login.active,false);
  assert.deepEqual(await login.code(started.attemptId,"good"),{type:"error",code:"login_not_active"});
});
test("lifetime abort closes native login and native link parsing rejects injected or incomplete links",async t=>{
  const {login,controller}=await fixture(t);const started=await login.login();controller.abort();await login.stop();assert.equal(login.active,false);
  for(const text of ["https://claude.ai.evil.test/\n","https://user:secret@claude.ai/\n","https://claude.ai/incomplete"])
    assert.equal(claudeAuth.codeLogin.link(text),undefined);
  assert.equal(claudeAuth.codeLogin.link("\x1b[32mhttps://claude.ai/oauth\x1b[0m\n"),"https://claude.ai/oauth");
});
test("auth stays non-quiescent through the pre-attach window and an exited-but-unsubmitted code attempt",async t=>{
  const source=`const fs=require('node:fs');console.log('Open https://claude.ai/oauth/authorize?test=1');console.log('Paste code:');setTimeout(()=>{fs.writeFileSync(process.argv[1],'ok');process.exit(0);},50);`;
  const {login,processes}=await fixture(t,source);
  const started=await login.login();assert.equal(started.type,"login");
  await new Promise(resolve=>processes[0].once("exit",resolve));await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(login.active,true);
  assert.deepEqual(await login.code(started.attemptId,"ignored"),{type:"status",authenticated:true});assert.equal(login.active,false);
  const {auth,context}=await fixture(t);
  const terminals=new AuthTerminals({status:auth.status,logout:auth.logout,terminal:auth.terminal},{},context.signal,()=>{});
  const opened=await terminals.handle({type:"terminal"},context.session);assert.equal(opened.type,"terminal");assert.equal(terminals.active,true);
  await terminals.handle({type:"close",terminalId:opened.terminalId},context.session);assert.equal(terminals.active,false);
});

test("Codex device login exposes its code, completes in the browser and releases its idle hold", async t => {
  const directory = await mkdtemp(join(tmpdir(), "codex-device-login-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "authenticated");
  const context = { signal: new AbortController().signal, session: { id: "auth" }, env: {} };
  const auth = { ...codexAuth, status: () => existsSync(file), logout: () => rm(file, { force: true }), terminal() {
    return spawn(process.execPath, ["-e", `console.log('private native diagnostics');console.log('https://auth.openai.com/codex/device');console.log('  \\x1b[34mABCD-EFGH\\x1b[0m');setInterval(()=>{if(require('fs').existsSync(process.argv[1]))process.exit(0)},5);`, file], { stdio: ["pipe", "pipe", "ignore"] });
  } };
  const login = new AuthCodeLogin(auth, codexAuth.codeLogin, context, () => {}, 1000);
  t.after(() => login.stop());
  const started = await login.login();
  assert.equal(started.type, "login"); assert.equal(started.userCode, "ABCD-EFGH");
  assert.equal(started.url, "https://auth.openai.com/codex/device");
  assert.doesNotMatch(JSON.stringify(started), /diagnostics/);
  assert.deepEqual(await login.code(started.attemptId, "ignored"), { type: "error", code: "device_login_requires_browser" });
  assert.equal(login.active, true); await writeFile(file, "signed-in");
  for (let i = 0; i < 100 && login.active; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(login.active, false);
  assert.deepEqual(await login.login(), { type: "status", authenticated: true });
  for (const bad of ["https://auth.openai.com.evil.test/codex/device\n", "https://user:pass@auth.openai.com/codex/device\n", "https://auth.openai.com/codex/device?injected=1\n"]) assert.equal(codexAuth.codeLogin.link(bad), undefined);
});
