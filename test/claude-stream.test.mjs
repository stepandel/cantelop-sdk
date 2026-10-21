import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeClaudeStream } from '../dist/harnesses/claude-stream.js';
import { until } from './helpers.mjs';

async function fixture(t) {
  const workspace = await mkdtemp('/tmp/claude-stream-');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const binary = join(workspace, 'claude');
  await writeFile(binary, String.raw`#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), rl=require('node:readline');
const args=process.argv.slice(2),at=args.indexOf('--resume')<0?args.indexOf('--session-id'):args.indexOf('--resume'),id=args[at+1];
const emit=e=>console.log(JSON.stringify(e));
emit({type:'system',subtype:'init',session_id:id});
const input=rl.createInterface({input:process.stdin});
input.on('line',line=>{
 const m=JSON.parse(line),text=m.message.content;
 const root=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','test');fs.mkdirSync(root,{recursive:true});fs.appendFileSync(path.join(root,id+'.jsonl'),line+'\n');
 emit({type:'metadata',args,prompt:text,id,uuid:m.uuid,pid:process.pid,sharedKey:!!process.env.ANTHROPIC_API_KEY});
 if(text==='late') {emit({type:'result',is_error:false});setTimeout(()=>{emit({...m});emit({type:'result',is_error:false});},20);return;}
 emit({...m});
 if(text==='hold')return;
 if(text==='stubborn'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
 if(text==='malformed'){console.log('{invalid');return;}
 emit({type:'assistant',message:{id:'answer',content:[{type:'text',text:'Answer '+text}]}});
 emit({type:'result',is_error:text==='fail',result:'Answer '+text});
});
`, { mode: 0o755 });
  const options = { workspace, binary, sessionId: 'session', conversation: { id: randomUUID(), resumable: false },
    permissionMode: 'dontAsk', settingSources: [], tools: ['Read'], mcps: {} };
  return { workspace, options };
}

test('native streaming input steers the same process and completes only after consumed input', async t => {
  const { options } = await fixture(t), events = [];
  const run = new NativeClaudeStream(options, new AbortController().signal, async e => { events.push(e); });
  const first = randomUUID(), second = randomUUID();
  await run.send(first, 'hold'); await until(() => events.some(e => e.type === 'user'));
  assert.equal(run.accepting, true);
  await run.send(second, 'adjust'); await run.done;
  const messages = events.filter(e => e.type === 'metadata');
  assert.deepEqual(messages.map(m => m.uuid), [first, second]);
  assert.equal(messages[0].pid, messages[1].pid);
  assert.ok(messages[0].args.includes('--input-format'));
  assert.equal(messages[0].args.includes('hold'), false);
  assert.equal(messages[0].sharedKey, false);
  assert.equal(run.accepting, false);
  await assert.rejects(run.send(randomUUID(), 'too late'), /finishing/);
});
test('a result before input acknowledgment does not drop an already handed-off input', async t => {
  const { options } = await fixture(t), events = [];
  const run = new NativeClaudeStream(options, new AbortController().signal, async e => { events.push(e); });
  await run.send(randomUUID(), 'late'); await run.done;
  assert.equal(events.filter(e => e.type === 'result').length, 2);
});
test('resume requires a transcript candidate and preserves the exact conversation', async t => {
  const { options } = await fixture(t), signal = new AbortController().signal;
  const first = new NativeClaudeStream(options, signal, async () => {});
  await first.send(randomUUID(), 'first'); await first.done;
  const events = [];
  const next = new NativeClaudeStream({ ...options, conversation: { ...options.conversation, resumable: true } }, signal, async e => { events.push(e); });
  await next.send(randomUUID(), 'second'); await next.done;
  assert.equal(events.find(e => e.type === 'metadata').args.includes('--resume'), true);
  const missing = new NativeClaudeStream({ ...options, conversation: { id: randomUUID(), resumable: true } }, signal, async () => {});
  await assert.rejects(missing.send(randomUUID(), 'new'), /native_resume_unavailable/);
  await assert.rejects(missing.done, /native_resume_unavailable/);
});
test('stream failures and lifetime cancellation wait for native cleanup', async t => {
  const { options } = await fixture(t);
  for (const prompt of ['fail', 'malformed']) {
    const run = new NativeClaudeStream(options, new AbortController().signal, async () => {});
    await run.send(randomUUID(), prompt); await assert.rejects(run.done);
  }
  const lifetime = new AbortController(), events = [];
  const run = new NativeClaudeStream(options, lifetime.signal, async e => { events.push(e); });
  await run.send(randomUUID(), 'stubborn'); await until(() => events.some(e => e.type === 'user'));
  lifetime.abort(); await assert.rejects(run.done);
  const pid = events.find(e => e.type === 'metadata').pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('stream publication failure cleans up the process and temporary system prompt', async t => {
  const { options } = await fixture(t); let promptPath;
  const run = new NativeClaudeStream({ ...options, systemPrompt: 'Private rules' }, new AbortController().signal, async e => {
    if (e.type === 'metadata') { promptPath = e.args[e.args.indexOf('--system-prompt-file') + 1]; throw new Error('publication failed'); }
  });
  await run.send(randomUUID(), 'hold'); await assert.rejects(run.done, /publication failed/);
  await assert.rejects(access(promptPath), { code: 'ENOENT' });
});
