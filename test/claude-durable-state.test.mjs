import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DurableClaudeStore } from '../dist/harnesses/claude-durable-state.js';
import { claudeView, observeClaude } from '../dist/harnesses/claude-view.js';
import { applyClaudeSessionChange } from '../dist/harnesses/claude-protocol.js';
async function fixture(t) {
  const root = await mkdtemp('/tmp/claude-state-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DurableClaudeStore(root, 'session'); await store.open(); return { root, store };
}
const input = id => ({ id, nativeId: randomUUID(), runId: 'run', text: id, status: 'accepted', fingerprint: 'fingerprint' });
test('state transactions retain publication intent across replacement and exclude credentials from views', async t => {
  const { root, store } = await fixture(t);
  await store.commit(s => { s.messages.push({ ...input('one'), settings: {mcps:{private:{type:'http',url:'https://example.test',headers:{Authorization:'secret'}}}} }); });
  const next = new DurableClaudeStore(root, 'session'); await next.open();
  assert.equal(next.state.revision, 1); assert.equal(next.state.outbox[0].revision, 1);
  assert.equal(JSON.stringify(next.state.outbox).includes('secret'), false);
  assert.equal(JSON.stringify(next.state).includes('secret'), true);
  await next.acknowledge(1);
  const again = new DurableClaudeStore(root, 'session'); await again.open();
  assert.equal(again.state.outbox.length, 0); assert.equal(again.state.messages.length, 1);
});
test('concurrent transactions preserve every accepted input and monotonic revisions', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({length:20}, (_,i) => store.commit(s => {s.messages.push(input(String(i)));})));
  assert.equal(store.state.messages.length, 20);
  assert.deepEqual(store.state.outbox.map(p => p.revision), Array.from({length:20}, (_,i) => i+1));
  const copy = store.state; copy.messages.length=0; assert.equal(store.state.messages.length,20);
});
test('failed persistence fences later transitions without publishing uncommitted memory', async t => {
  const { store } = await fixture(t); await mkdir(store.path);
  await assert.rejects(store.commit(s => {s.messages.push(input('lost'));}));
  await assert.rejects(store.commit(s => {s.messages.push(input('later'));}));
  assert.equal(store.state.messages.length, 0); assert.equal(store.state.revision, 0);
});
test('legacy queues migrate to explicit interruption and drop private settings', async t => {
  const { root, store } = await fixture(t);
  await writeFile(store.path, JSON.stringify({conversationId:randomUUID(),resume:true,queue:['waiting'],messages:[
    {id:'waiting',text:'old pending job',status:'queued',settingsHash:'h',settings:{systemPrompt:'secret'}},
    {id:'active',text:'unknown execution',status:'running',settingsHash:'h'},
  ]}));
  const migrated = new DurableClaudeStore(root,'session'); await migrated.open();
  assert.equal(migrated.state.nativeStarted,true);
  assert.deepEqual(migrated.state.messages.map(m=>m.status),['interrupted','interrupted']);
  await migrated.commit(()=>{});
  assert.equal((await readFile(store.path,'utf8')).includes('secret'),false);
});
test('corrupt and unsupported state fail activation', async t => {
  const { root,store } = await fixture(t);
  for(const value of [{}, {version:9,messages:[],conversationId:randomUUID()}, {version:2,revision:1,messages:[{}],conversationId:randomUUID()}]){
    await writeFile(store.path,JSON.stringify(value));await assert.rejects(new DurableClaudeStore(root,'session').open(),/Invalid/);
  }
});
test('view reduction reconstructs streamed text, final messages, tool outcomes and usage', async t => {
  const { store } = await fixture(t),s=store.state;
  s.run={id:'run',inputIds:['one'],status:'running'};
  for(const event of [
    {type:'stream_event',event:{type:'message_start',message:{id:'assistant'}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello '}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'😀'}}},
    {type:'assistant',message:{id:'assistant',content:[{type:'text',text:'Hello 😀'},{type:'tool_use',id:'tool',name:'Read',input:{path:'file'}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'contents'}]}},
    {type:'result',result:'Hello 😀',usage:{input_tokens:10,output_tokens:20},total_cost_usd:0.1},
  ])observeClaude(s,event);
  assert.equal(s.entries.filter(e=>e.role==='assistant').length,1);
  assert.equal(s.entries[0].text,'Hello 😀');
  assert.deepEqual(s.entries.find(e=>e.id==='tool'),{id:'tool',runId:'run',role:'tool',text:'contents',toolName:'Read',status:'completed'});
  assert.equal(s.usage.outputTokens,20);
});
test('bounded UTF-8 projections and duplicate change application support reconnect', async t => {
  const { store } = await fixture(t),s=store.state;
  s.run={id:'run',inputIds:[],status:'running'};
  for(let i=0;i<80;i++)observeClaude(s,{type:'assistant',message:{id:String(i),content:[{type:'text',text:'😀'.repeat(5000)}]}});
  s.messages.push({...input('huge'),text:'😀'.repeat(20000)});s.revision=20;
  const view=claudeView(s);
  assert.ok(Buffer.byteLength(JSON.stringify(view))<49*1024);assert.equal(view.truncated,true);
  assert.equal(view.inputs[0].text.endsWith('😀'),true);
  const change={type:'session.changed',revision:20,state:view};
  const before={...view,revision:19};const after=applyClaudeSessionChange(before,change);
  assert.deepEqual(after,view);assert.equal(applyClaudeSessionChange(after,change),after);
  assert.throws(()=>applyClaudeSessionChange(after,{...change,revision:21}),/Invalid/);
});
test('a rejected mutation fails only its own transaction', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.commit(() => { throw new Error('invalid transition'); }), /invalid transition/);
  await store.commit(s => { s.messages.push(input('next')); });
  assert.equal(store.state.revision, 1); assert.equal(store.state.messages.length, 1);
});
