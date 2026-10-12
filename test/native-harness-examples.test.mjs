import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

async function load(path) {
  const bundle = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}
const providers = [
  ["codex", (await load("../examples/codex/src/native.ts")).NativeCodex],
  ["claude", (await load("../examples/anthropic/src/native.ts")).NativeClaude],
  ["opencode", (await load("../examples/opencode/src/native.ts")).NativeOpenCode],
];

// Real subprocess/stdin/JSONL/process-group boundaries; no provider credentials or model calls.
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), "native-cli-example-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const binary = join(workspace, "native-cli");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), {spawn} = require('node:child_process');
const args = process.argv.slice(2);
const provider = args[0] === 'exec' ? 'codex' : args[0] === '-p' ? 'claude' : 'opencode';
const root = provider === 'codex' ? process.env.CODEX_HOME : provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : path.join(process.env.XDG_DATA_HOME,'opencode');
fs.mkdirSync(root,{recursive:true});
const store = path.join(root,'fake-sessions.json');
let sessions = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store,'utf8')) : {};
if(args[0] === 'import') {
 const value = JSON.parse(fs.readFileSync(args[1],'utf8')); sessions[value.info.id] = value.messages;
 fs.writeFileSync(store,JSON.stringify(sessions)); console.log('Imported session: '+value.info.id); process.exit(0);
}
if(args[0] === 'export') {
 const id = args[1]; console.log(JSON.stringify({info:{id},messages:sessions[id] || []},null,2)); process.exit(0);
}
let text=''; process.stdin.on('data',chunk=>text+=chunk); process.stdin.on('end',()=>{
 let id;
 if(provider==='codex') { const at=args.indexOf('resume'); id=at<0?crypto.randomUUID():args[at+1]; }
 if(provider==='claude') {const at=args.indexOf('--resume')>=0?args.indexOf('--resume'):args.indexOf('--session-id'); id=args[at+1];}
 if(provider==='opencode') {const at=args.indexOf('--session'); id=at<0?'ses_'+crypto.randomUUID().replaceAll('-',''):args[at+1];}
 sessions[id] ||= []; sessions[id].push(text); fs.writeFileSync(store,JSON.stringify(sessions));
 const meta={args,stdin:text,id,history:sessions[id],cwd:process.cwd(),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,codex:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME,xdg:process.env.XDG_DATA_HOME,sharedKey:!!process.env.ANTHROPIC_API_KEY||!!process.env.OPENAI_API_KEY||!!process.env.CANTELOP_INTEGRATION_TOKEN};
 const emit=e=>console.log(JSON.stringify(e));
 if(provider==='codex')emit({type:'thread.started',thread_id:id});
 if(provider==='claude')emit({type:'system',subtype:'init',session_id:id});
 if(provider==='opencode')emit({type:'step_start',sessionID:id});
 emit({type:'metadata',...meta});
 if(text==='wait') {
  process.on('SIGTERM',()=>{});
  spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'tool.ready',pid:process.pid}));setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
  setInterval(()=>{},1000);return;
 }
 if(text==='malformed'){process.stdout.write('{bad json');return;}
 if(text==='missing'){process.stdout.write(JSON.stringify({type:'text',text:'incomplete'}));return;}
 if(provider==='codex')process.stdout.write(JSON.stringify(text==='fail'?{type:'turn.failed',error:{message:'failed'}}:{type:'turn.completed',text:'Hello 😀'}));
 if(provider==='claude')process.stdout.write(JSON.stringify({type:'result',is_error:text==='fail',text:'Hello 😀'}));
 if(provider==='opencode')process.stdout.write(JSON.stringify(text==='fail'?{type:'error',sessionID:id}:{type:'step_finish',sessionID:id,part:{reason:'stop'},text:'Hello 😀'}));
});
`, { mode: 0o755 });
  return { workspace, binary };
}
const run = (native, turn) => native.run({ type: "prompt", prompt: turn.text }, { signal: turn.signal, output: { send: turn.emit } });
const turn = (text, events, signal = new AbortController().signal) => ({ text, signal, emit: async event => { events.push(event); } });
async function assertToolExited(pid) {
  // Group termination closes the pipes before the host necessarily reaps an
  // orphaned tool. Wait for OS bookkeeping before asserting that its PID is gone.
  const deadline = Date.now() + 2000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    assert.ok(Date.now() < deadline, "native tool PID was not reaped after termination");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}


for (const [name, Native] of providers) {
  test(`${name} wraps the stock CLI command, keeps prompts on stdin, and resumes after replacement`, async t => {
    const options = { ...await fixture(t), sessionId: "one" };
    const events = [];
    const native = new Native(options);
    await run(native, turn("first", events));
    const first = events.find(event => event.type === "metadata");
    assert.equal(first.stdin, "first");
    assert.equal(first.args.includes("first"), false);
    assert.equal(first.sharedKey, false);
    assert.equal(first.home, options.workspace);
    const next = [];
    await run(new Native(options), turn("second", next));
    const metadata = next.find(event => event.type === "metadata");
    assert.equal(metadata.id, first.id);
    assert.deepEqual(metadata.history, ["first", "second"]);
    assert.equal(next.at(-1).text, "Hello 😀"); // Final JSON frame has no newline.
    const other = [];
    await run(new Native({ ...options, sessionId: "other" }), turn("other", other));
    assert.notEqual(other.find(event => event.type === "metadata").id, first.id);
    if (name === "opencode") {
      assert.equal(metadata.xdg.startsWith(options.workspace), false, "live SQLite stays local");
      const snapshotDirectory = join(options.workspace,".cantelop","native-harness","opencode");
      assert.equal((await stat(snapshotDirectory)).mode & 0o777, 0o700);
    }
    if (name === "codex") assert.equal(metadata.sqlite.startsWith(options.workspace), false);
    // The native runner implements SessionHarness directly.
    const output = [];
    await native.run({ type: "prompt", prompt: "adapted" }, { signal: new AbortController().signal, output: { send: async event => output.push(event) } });
    assert.equal(output.some(event => event.type === "metadata" && event.stdin === "adapted"), true);
  });

  test(`${name} cancellation waits for real process-group exit and stubborn tool cleanup`, async t => {
    const native = new Native({ ...await fixture(t), sessionId: "one" });
    const controller = new AbortController();
    let toolPid, abortedAt;
    const execution = run(native, { text: "wait", signal: controller.signal, emit: async event => {
      if (event.type === "tool.ready") { toolPid = event.pid; abortedAt = Date.now(); controller.abort(); }
    } });
    await assert.rejects(execution, /abort/i);
    assert.ok(Date.now() - abortedAt >= 900);
    await assertToolExited(toolPid);
  });

  test(`${name} output failure cleans up before returning; native failures never become success`, async t => {
    const native = new Native({ ...await fixture(t), sessionId: "one" });
    let toolPid;
    await assert.rejects(run(native, { text: "wait", signal: new AbortController().signal, emit: async event => {
      if (event.type === "tool.ready") { toolPid = event.pid; throw new Error("handoff failed"); }
    } }), /handoff failed/);
    await assertToolExited(toolPid);
    for (const prompt of ["fail", "missing", "malformed"]) await assert.rejects(run(native, turn(prompt, [])));
  });
}

test("large native frames are fragmented below the output limit and round-trip Unicode", async () => {
  const { NativeHarness } = await load("../examples/native-harness/cli.ts");
  const nativeEvent = { type: "assistant", text: "😀".repeat(30_000) };
  const harness = new class extends NativeHarness { async execute(turn) { await turn.emit(nativeEvent); } }();
  const events = [];
  await harness.run({ type: "prompt", prompt: "test" }, { signal: new AbortController().signal, output: { send: async event => events.push(event) } });
  assert.equal(events.length > 1, true);
  assert.equal(events.every(event => event.type === "native.fragment" && Buffer.byteLength(JSON.stringify(event)) < 64 * 1024), true);
  assert.deepEqual(JSON.parse(events.map(event => event.json).join("")), nativeEvent);
});

test("incarnation shutdown interrupts a blocked output handoff and still waits for native cleanup", async () => {
  const { NativeHarness } = await load("../examples/native-harness/cli.ts");
  const lifetime = new AbortController();
  let publishing = false, exited = false;
  const harness = new class extends NativeHarness { async execute(turn) {
    try { await turn.emit({ type: "assistant" }); }
    finally { await new Promise(resolve => setTimeout(resolve, 10)); exited = true; }
  } }(lifetime.signal);
  const outcome = assert.rejects(harness.run({ type: "prompt", prompt: "hold" }, {
    signal: new AbortController().signal,
    output: { send: () => { publishing = true; return new Promise(() => {}); } },
  }), /abort/i);
  while (!publishing) await new Promise(resolve => setImmediate(resolve));
  lifetime.abort();
  await outcome;
  assert.equal(exited, true);
});
