import assert from "node:assert/strict";
import test, { after } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createClaudeHarness, NativeClaude } from "@cantelop/sdk/harnesses/claude";

const moduleDirectory = await mkdtemp(join(tmpdir(), "native-harness-modules-"));
after(() => rm(moduleDirectory, { recursive: true, force: true }));
let moduleSequence = 0;
async function load(path) {
  const bundle = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
  const modulePath = join(moduleDirectory, `module-${++moduleSequence}.mjs`);
  await writeFile(modulePath, bundle.outputFiles[0].text);
  return import(pathToFileURL(modulePath).href);
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
 const promptAt=args.indexOf('--system-prompt-file'), promptPath=promptAt<0?undefined:args[promptAt+1];
 const meta={systemPrompt:promptPath?fs.readFileSync(promptPath,'utf8'):undefined,promptMode:promptPath?fs.statSync(promptPath).mode & 0o777:undefined,promptPath,args,stdin:text,id,history:sessions[id],cwd:process.cwd(),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,codex:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME,xdg:process.env.XDG_DATA_HOME,sharedKey:!!process.env.ANTHROPIC_API_KEY||!!process.env.OPENAI_API_KEY||!!process.env.CANTELOP_INTEGRATION_TOKEN};
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
 if(provider==='claude')process.stdout.write(JSON.stringify({type:'result',is_error:text==='fail',text:text==='large'?'😀'.repeat(40000):'Hello 😀'}));
 if(provider==='opencode')process.stdout.write(JSON.stringify(text==='fail'?{type:'error',sessionID:id}:{type:'step_finish',sessionID:id,part:{reason:'stop'},text:'Hello 😀'}));
});
`, { mode: 0o755 });
  return { workspace, binary };
}
const run = (native, turn) => native.queue({ type: "prompt", prompt: turn.text }, { signal: turn.signal, output: { send: turn.emit } });
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
  });

  test(`${name} cancellation waits for real process-group exit and stubborn tool cleanup`, async t => {
    const native = new Native({ ...await fixture(t), sessionId: "one" });
    const controller = new AbortController();
    let toolPid, abortedAt;
    const execution = run(native, { text: "wait", signal: controller.signal, emit: async event => {
      if (event.type === "tool.ready") { toolPid = event.pid; abortedAt = Date.now(); assert.equal(native.cancel(), true); }
    } });
    await assert.rejects(execution, /abort/i);
    assert.ok(Date.now() - abortedAt >= 900);
    assert.equal(controller.signal.aborted, false, "cancellation belongs to the harness");
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
  const { CliHarness } = await load("../examples/native-harness/cli.ts");
  const nativeEvent = { type: "assistant", text: "😀".repeat(30_000) };
  const harness = new class extends CliHarness { async execute(turn) { await turn.emit(nativeEvent); } }();
  const events = [];
  await harness.queue({ type: "prompt", prompt: "test" }, { signal: new AbortController().signal, output: { send: async event => events.push(event) } });
  assert.equal(events.length > 1, true);
  assert.equal(events.every(event => event.type === "native.fragment" && Buffer.byteLength(JSON.stringify(event)) < 64 * 1024), true);
  assert.deepEqual(JSON.parse(events.map(event => event.json).join("")), nativeEvent);
});

test("incarnation shutdown interrupts a blocked output handoff and still waits for native cleanup", async () => {
  const { CliHarness } = await load("../examples/native-harness/cli.ts");
  const lifetime = new AbortController();
  let publishing = false, exited = false;
  const harness = new class extends CliHarness { async execute(turn) {
    try { await turn.emit({ type: "assistant" }); }
    finally { await new Promise(resolve => setTimeout(resolve, 10)); exited = true; }
  } }(lifetime.signal);
  const outcome = assert.rejects(harness.queue({ type: "prompt", prompt: "hold" }, {
    signal: new AbortController().signal,
    output: { send: () => { publishing = true; return new Promise(() => {}); } },
  }), /abort/i);
  while (!publishing) await new Promise(resolve => setImmediate(resolve));
  lifetime.abort();
  await outcome;
  assert.equal(exited, true);
});

test("CLI harness steer owns interruption, priority FIFO and its cleanup barrier", async () => {
  const { CliHarness } = await load("../examples/native-harness/cli.ts");
  let release;
  const cleanup = new Promise(resolve => { release = resolve; });
  const started = [], origins = [];
  const context = new AsyncLocalStorage();
  let active;
  const native = new class extends CliHarness {
    async execute(turn) {
      started.push(turn.text); origins.push(context.getStore());
      if (turn.text === "hold") {
        active = turn.signal;
        await new Promise(resolve => turn.signal.addEventListener("abort", resolve, { once: true }));
        await cleanup;
      }
    }
  }();
  const work = () => ({ signal: new AbortController().signal, output: { send: async () => {} } });
  const first = assert.rejects(context.run("hold", () => native.queue({ type: "prompt", prompt: "hold" }, work())), /abort/i);
  while (!active) await new Promise(resolve => setImmediate(resolve));
  const ordinary = context.run("normal", () => native.queue({ type: "prompt", prompt: "normal" }, work()));
  const priority1 = context.run("direction-1", () => native.steer({ type: "prompt", prompt: "direction-1" }, work()));
  const priority2 = context.run("direction-2", () => native.steer({ type: "prompt", prompt: "direction-2" }, work()));
  assert.equal(active.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["hold"]);
  release(); await Promise.all([first, ordinary, priority1, priority2]);
  assert.deepEqual(started, ["hold", "direction-1", "direction-2", "normal"]);
  assert.deepEqual(origins, started, "queued turns retain their own logging context");
  assert.equal(native.cancel(), false, "completion includes releasing the provider slot");
});

test("CLI harness rejects a full queue before steer can interrupt unrelated work", async () => {
  const { CliHarness } = await load("../examples/native-harness/cli.ts");
  let release, active;
  const exit = new Promise(resolve => { release = resolve; });
  const native = new class extends CliHarness {
    async execute(turn) { if (turn.text === "hold") { active = turn.signal; await exit; } }
  }();
  const work = () => ({ signal: new AbortController().signal, output: { send: async () => {} } });
  const first = native.queue({ type: "prompt", prompt: "hold" }, work());
  while (!active) await new Promise(resolve => setImmediate(resolve));
  const waiting = Array.from({ length: 256 }, () => native.queue({ type: "prompt", prompt: "normal" }, work()));
  assert.throws(() => native.steer({ type: "prompt", prompt: "direction" }, work()), /capacity/);
  assert.equal(active.aborted, false);
  release(); await Promise.all([first, ...waiting]);
});


test("queued input expiry removes only that harness submission", async () => {
  const { CliHarness } = await load("../examples/native-harness/cli.ts");
  let release, active;
  const started = [];
  const exit = new Promise(resolve => { release = resolve; });
  const native = new class extends CliHarness {
    async execute(turn) {
      started.push(turn.text);
      if (turn.text === "hold") { active = turn.signal; await exit; }
    }
  }();
  const work = signal => ({ signal, output: { send: async () => {} } });
  const first = native.queue({ type: "prompt", prompt: "hold" }, work(new AbortController().signal));
  while (!active) await new Promise(resolve => setImmediate(resolve));
  const owner = new AbortController();
  const expired = assert.rejects(native.queue({ type: "prompt", prompt: "expired" }, work(owner.signal)), /abort/i);
  const kept = native.queue({ type: "prompt", prompt: "kept" }, work(new AbortController().signal));
  owner.abort(); await expired;
  assert.equal(active.aborted, false);
  release(); await Promise.all([first, kept]);
  assert.deepEqual(started, ["hold", "kept"]);
});


test("packaged Claude factory rejects a stopped incarnation before constructing the runner", () => {
  const lifetime = new AbortController();
  lifetime.abort();
  assert.throws(() => createClaudeHarness({ signal: lifetime.signal }), /abort/i);
  const native = createClaudeHarness({
    signal: new AbortController().signal, session: { id: "factory-session" },
    env: { CLAUDE_PATH: "/missing/claude", CLAUDE_MODEL: "test-model" },
  });
  assert.ok(native instanceof NativeClaude);
  assert.equal(native.cancel(), false);
});

test("packaged Claude preserves restricted execution settings and existing conversation on migration", async t => {
  const {workspace,binary}=await fixture(t);
  const id="12345678-1234-4234-8234-123456789abc";
  const native=new NativeClaude({workspace,binary,sessionId:"migrated",model:"claude-sonnet-5",
    conversation:{id,resumable:true},permissionMode:"dontAsk",settingSources:[],tools:["Read"],allowedTools:["Read"],maxTurns:8,mcps:{}});
  const events=[];await run(native,turn("existing",events));
  const metadata=events.find(event=>event.type==="metadata");
  assert.equal(metadata.id,id);
  assert.equal(metadata.args[metadata.args.indexOf("--resume")+1],id);
  assert.equal(metadata.args[metadata.args.indexOf("--permission-mode")+1],"dontAsk");
  assert.equal(metadata.args[metadata.args.indexOf("--tools")+1],"Read");
  assert.equal(metadata.args[metadata.args.indexOf("--max-turns")+1],"8");
  assert.deepEqual(JSON.parse(metadata.args[metadata.args.indexOf("--mcp-config")+1]),{mcpServers:{}});
  const replacement=new NativeClaude({workspace,binary,sessionId:"migrated",conversation:{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",resumable:true}});
  const later=[];await run(replacement,turn("later",later));
  assert.equal(later.find(event=>event.type==="metadata").id,id,"persisted SDK state wins over the migration seed");
});


test("configured Claude factory snapshots Session settings and persists migration through public queue", async t => {
  const { workspace, binary } = await fixture(t);
  const id = "12345678-1234-4234-8234-123456789abc";
  const lifetime = new AbortController();
  const context = { signal: lifetime.signal, session: { id: "configured-factory" }, env: { CLAUDE_PATH: "/missing/claude", CLAUDE_MODEL: "fallback-model" } };
  const options = { workspace, binary, model: "sonnet", permissionMode: "dontAsk", settingSources: [],
    tools: [], allowedTools: ["mcp__project__edit"], mcps: { project: { type: "http", url: "https://tools.example/mcp", headers: { Authorization: "run-token" } } },
    maxTurns: 24, systemPrompt: "Project rules 😀", conversation: { id, resumable: true } };
  const native = createClaudeHarness(context, options);
  options.tools.push("Bash"); options.allowedTools.push("Bash"); options.mcps.project.headers.Authorization = "changed";
  options.conversation.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  options.systemPrompt = "Changed prompt";
  const events = []; await run(native, turn("first", events));
  const metadata = events.find(event => event.type === "metadata");
  const value = flag => metadata.args[metadata.args.indexOf(flag) + 1];
  assert.equal(value("--model"), "sonnet");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--setting-sources"), "");
  assert.equal(value("--tools"), "");
  assert.equal(value("--allowedTools"), "mcp__project__edit");
  assert.equal(value("--max-turns"), "24");
  assert.equal(value("--resume"), id);
  assert.equal(metadata.systemPrompt, "Project rules 😀");
  assert.equal(metadata.promptMode, 0o600);
  assert.equal(metadata.args.includes(metadata.systemPrompt), false);
  assert.deepEqual(JSON.parse(value("--mcp-config")), { mcpServers: { project: { type: "http", url: "https://tools.example/mcp", headers: { Authorization: "run-token" } } } });
  await assert.rejects(access(metadata.promptPath));
  const later = [];
  await run(createClaudeHarness(context, { workspace, binary, conversation: options.conversation }), turn("second", later));
  assert.equal(later.find(event => event.type === "metadata").id, id);
  assert.deepEqual(later.find(event => event.type === "metadata").history, ["first", "second"]);
});

test("default Claude factory honors environment defaults and canonical Session identity", async t => {
  const { workspace, binary } = await fixture(t);
  const context = { signal: new AbortController().signal, session: { id: "canonical" }, env: { CLAUDE_PATH: binary, CLAUDE_MODEL: "environment-model" } };
  const events = [];
  const native = createClaudeHarness(context, { workspace, sessionId: "must-not-override" });
  await run(native, turn("first", events));
  const metadata = events.find(event => event.type === "metadata");
  assert.equal(metadata.args[metadata.args.indexOf("--model") + 1], "environment-model");
  for (const flag of ["--tools", "--permission-mode", "--mcp-config", "--system-prompt-file", "--max-turns"]) assert.equal(metadata.args.includes(flag), false);
  const later = [];
  await run(createClaudeHarness(context, { workspace }), turn("second", later));
  assert.equal(later.find(event => event.type === "metadata").id, metadata.id, "Session identity cannot be redirected by options");
});

test("configured factory preserves cleanup before public cancellation and queued input settle", async t => {
  const { workspace, binary } = await fixture(t);
  const native = createClaudeHarness({ signal: new AbortController().signal, session: { id: "factory-cancel" }, env: {} }, { workspace, binary });
  const events = []; let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const first = assert.rejects(run(native, { text: "wait", signal: new AbortController().signal, emit: async event => {
    events.push(event); if (event.type === "tool.ready") ready();
  } }), /abort/i);
  await started;
  const next = [];
  const queued = run(native, turn("after", next));
  assert.equal(native.cancel(), true);
  await Promise.all([first, queued]);
  assert.equal(native.cancel(), false);
  await assertToolExited(events.find(event => event.type === "tool.ready").pid);
  assert.ok(next.some(event => event.type === "result"));
});


test("configured factory owns fragmentation without a caller's stream parser", async t => {
  const { workspace, binary } = await fixture(t);
  const native = createClaudeHarness({ signal: new AbortController().signal, session: { id: "factory-fragments" }, env: {} }, { workspace, binary });
  const events = []; await run(native, turn("large", events));
  const fragments = events.filter(event => event.type === "native.fragment");
  assert.ok(fragments.length > 1);
  assert.ok(fragments.every(event => Buffer.byteLength(JSON.stringify(event)) < 48000));
  const result = JSON.parse(fragments.map(event => event.json).join(""));
  assert.equal(result.type, "result");
  assert.equal(result.text, "😀".repeat(40000));
});
