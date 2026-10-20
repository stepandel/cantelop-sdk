import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClaudeRuntime, ClaudeAuthenticationRequired } from '../dist/harnesses/claude.js';
import { DurableClaudeStore } from '../dist/harnesses/claude-durable-state.js';
import { InMemoryActivity } from '../dist/activity.js';
import { applyClaudeSessionChange } from '../dist/harnesses/claude-protocol.js';
import { until } from './helpers.mjs';

class FakeClaude {
  runs = [];
  create = (context, options, emit) => {
    let resolve,reject;
    const done=new Promise((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
    const run={context,options,emit,done,accepting:true,inputs:[],
      async send(id,text){
        if(!run.accepting)throw new Error('finishing');
        run.inputs.push({id,text});
        await emit({type:'system',subtype:'init',session_id:options.conversation.id});
        await emit({type:'user',uuid:id,message:{role:'user',content:text}});
      },
      cancel(){run.accepting=false;reject(new Error('aborted'));},
      async finish(result='Answer',is_error=false){
        run.accepting=false;
        await emit({type:'assistant',message:{id:'answer-'+context.session.id,content:[{type:'text',text:result}]}});
        await emit({type:'result',result,is_error,usage:{input_tokens:10,output_tokens:20},total_cost_usd:0.1});
        if(is_error)reject(new Error('failed'));else resolve();
      },
      reject(error){run.accepting=false;reject(error);},
    };
    const abort=()=>run.cancel();context.signal.addEventListener('abort',abort,{once:true});
    void done.finally(()=>context.signal.removeEventListener('abort',abort)).catch(()=>{});
    if(context.signal.aborted)abort();
    this.runs.push(run);return run;
  };
}
function harness(root,native,settings={},faults={}){
  const behaviour=createClaudeRuntime({workspace:root,permissionMode:'dontAsk',settingSources:[],...settings},native.create);
  const events=[],views=[],replies=[],lifetime=new AbortController();let mailbox=Promise.resolve();
  const output={send:async event=>{events.push(structuredClone(event));if(faults.output?.(event))throw new Error('output unavailable');}};
  const view={commit:async value=>{if(faults.view?.(value))throw new Error('view unavailable');views.push(structuredClone(value));}};
  const activity=new InMemoryActivity(command=>send(command),async(_id,event,signal)=>{signal.throwIfAborted();await output.send(event);},()=>{},async(_id,value,signal)=>{signal.throwIfAborted();await view.commit(value);});
  const capability={get active(){return activity.active;},start(work,options){activity.start('platform-message',work,options);},cancel:()=>activity.cancel(),extend:ms=>activity.extend(ms)};
  const base={session:{id:'session-a',workspaceSlug:'user',keepAliveSeconds:300},env:{},database:async()=>{throw Error('Database not used');},signal:lifetime.signal,activity:capability,output,view,send:async command=>{void send(command);}};
  const send=(command, messageId=randomUUID())=>{const result=mailbox.then(()=>behaviour.receive({...base,command:{type:'dispatch'},message:{id:messageId,sequence:1,payload:command},reply:value=>replies.push(value)}));mailbox=result.catch(()=>{});return result;};
  const activated=behaviour.onActivate(base);mailbox=activated.catch(()=>{});
  return {behaviour,events,views,replies,send,activated,lifetime,base,
    recover:()=>behaviour.onRecover({...base,recovery:{id:'recovery',interruptedMessageId:'platform-message'}}),
    idle:async()=>{await until(()=>activity.isIdle);await mailbox;},
    async close(){lifetime.abort();await until(()=>activity.isIdle);},
  };
}
async function fixture(t,settings={},faults={}){
  const root=await mkdtemp('/tmp/claude-runtime-'),native=new FakeClaude(),h=harness(root,native,settings,faults);
  t.after(async()=>{await h.close();await rm(root,{recursive:true,force:true});});
  await h.activated;return {root,native,h};
}
async function disk(root){const store=new DurableClaudeStore(root,'session-a');await store.open();return store.state;}

test('idle input starts execution; busy input steers the same run and view records both outcomes',async t=>{
  const {native,h}=await fixture(t,{model:'sonnet',tools:['Read']});
  await h.send({type:'input',id:'a',text:'Investigate'});await until(()=>native.runs[0]?.inputs.length===1);
  await h.send({type:'steer',id:'b',text:'Focus on auth'});
  assert.equal(native.runs.length,1);assert.deepEqual(native.runs[0].inputs.map(i=>i.text),['Investigate','Focus on auth']);
  const running=h.views.at(-1);assert.equal(running.run.inputIds.length,2);assert.deepEqual(running.inputs.map(m=>m.status),['running','running']);
  await native.runs[0].finish('Auth finding');await h.idle();
  const view=h.views.at(-1);assert.equal(view.run.status,'completed');assert.deepEqual(view.inputs.map(m=>m.status),['completed','completed']);
  assert.equal(view.entries.find(e=>e.role==='assistant').text,'Auth finding');assert.equal(view.usage.outputTokens,20);
});
test('legacy queue commands are rejected instead of silently steering',async t=>{
  const {native,h}=await fixture(t);await h.send({type:'queue',id:'old',text:'old'});
  assert.deepEqual(h.replies.at(-1),{type:'error',code:'unsupported_command'});assert.equal(native.runs.length,0);
});
test('duplicates are idempotent across completion and replacement; conflicting payloads are rejected',async t=>{
  const {root,native,h}=await fixture(t);const command={type:'input',id:'once',text:'One',settings:{model:'sonnet'}};
  await h.send(command);await until(()=>native.runs[0]?.inputs.length===1);
  await h.send(command);assert.equal(native.runs[0].inputs.length,1);
  await native.runs[0].finish();await h.idle();
  const nextNative=new FakeClaude(),next=harness(root,nextNative);await next.activated;
  await next.send({...command,type:'steer'});assert.equal(nextNative.runs.length,0);assert.equal(next.replies.at(-1).status,'completed');
  await next.send({...command,text:'Changed'});assert.equal(next.replies.at(-1).code,'message_id_conflict');await next.close();
});
test('busy steering inherits active settings and rejects configuration changes before admission',async t=>{
  const {root,native,h}=await fixture(t,{model:'sonnet',tools:['Read']});
  await h.send({type:'input',id:'one',text:'One',settings:{model:'opus'}});await until(()=>native.runs[0]?.inputs.length===1);
  await h.send({type:'input',id:'two',text:'Two'});assert.equal(native.runs[0].options.model,'opus');
  await h.send({type:'steer',id:'bad',text:'Bad',settings:{tools:['Write']}});
  assert.equal(h.replies.at(-1).code,'active_settings_conflict');assert.equal((await disk(root)).messages.length,2);
  await native.runs[0].finish();await h.idle();
  await h.send({type:'input',id:'next',text:'Next'});await until(()=>native.runs[1]?.inputs.length===1);
  assert.equal(native.runs[1].options.model,'sonnet');await native.runs[1].finish();await h.idle();
});
test('cancellation persists intent and interrupts the active run without affecting the next one',async t=>{
  const {native,h}=await fixture(t);await h.send({type:'input',id:'a',text:'A'});await until(()=>native.runs[0]?.inputs.length===1);
  await h.send({type:'cancel',id:'a'});await h.idle();
  assert.equal(h.views.at(-1).run.status,'cancelled');assert.equal(h.views.at(-1).inputs[0].status,'cancelled');
  await h.send({type:'input',id:'b',text:'B'});await until(()=>native.runs[1]?.inputs.length===1);
  await h.send({type:'cancel',id:'a'});assert.equal(h.replies.at(-1).requested,false);
  await native.runs[1].finish();await h.idle();
});
test('native results are durable before publication and completion waits for recorded native consumption',async t=>{
  const {root,native,h}=await fixture(t);await h.send({type:'input',id:'a',text:'A'});await until(()=>native.runs[0]?.inputs.length===1);
  const original=h.base.output.send;
  h.base.output.send=async event=>{if(event.type==='claude'&&event.event.type==='result'){
    const saved=await disk(root);assert.equal(saved.messages[0].status,'completed');assert.ok(saved.outbox.some(p=>p.events.some(e=>e.type==='claude'&&e.event.type==='result')));
  }await original(event);};
  await native.runs[0].finish('Durable answer');await h.idle();
  assert.equal((await disk(root)).outbox.length,0);
});
test('snapshot reads the same typed projection as view commits',async t=>{
  const {h}=await fixture(t);await h.send({type:'snapshot'});assert.deepEqual(h.replies.at(-1),{type:'session.state',state:h.views.at(-1)});
});
test('reconnect and duplicate publication reduce to the committed projection',async t=>{
  const {native,h}=await fixture(t),snapshot=h.views.at(-1),offset=h.events.length;
  await h.send({type:'input',id:'a',text:'A'});await until(()=>native.runs[0]?.inputs.length===1);
  await native.runs[0].finish('Restored');await h.idle();
  let current=snapshot;
  for(const event of h.events.slice(offset))if(event.type==='session.changed'){current=applyClaudeSessionChange(current,event);current=applyClaudeSessionChange(current,event);}
  assert.deepEqual(current,h.views.at(-1));
});
test('activation restores only never-attempted delivery and marks uncertain native execution interrupted',async t=>{
  const {root,h}=await fixture(t);await h.close();
  const store=new DurableClaudeStore(root,'session-a');await store.open();
  await store.commit(s=>{
    s.run={id:'old-run',inputIds:['unknown','waiting'],status:'running'};
    s.messages.push({id:'unknown',runId:'old-run',text:'Unknown',nativeId:randomUUID(),fingerprint:'h',status:'delivering'},
      {id:'waiting',runId:'old-run',text:'Never handed off',nativeId:randomUUID(),fingerprint:'h',status:'accepted',settings:{model:'opus'}});
  });
  const native=new FakeClaude(),next=harness(root,native);await next.activated;await until(()=>native.runs[0]?.inputs.length===1);
  assert.equal(native.runs[0].inputs[0].text,'Never handed off');assert.equal(native.runs[0].options.model,'opus');
  assert.equal(next.views.at(-1).inputs.find(m=>m.id==='unknown').status,'interrupted');
  await native.runs[0].finish();await next.idle();await next.close();
});
test('attempted input is never automatically resubmitted; explicit input resumes the same conversation',async t=>{
  const {root,h}=await fixture(t);await h.close();const store=new DurableClaudeStore(root,'session-a');await store.open();
  await store.commit(s=>{s.nativeStarted=true;s.messages.push({id:'old',runId:'old-run',text:'May have effects',nativeId:randomUUID(),fingerprint:'h',status:'running'});s.run={id:'old-run',inputIds:['old'],status:'running'};});
  const native=new FakeClaude(),next=harness(root,native);await next.activated;assert.equal(native.runs.length,0);
  await next.send({type:'input',id:'new',text:'Inspect current state'});await until(()=>native.runs[0]?.inputs.length===1);
  assert.equal(native.runs[0].options.conversation.resumable,true);assert.equal(native.runs[0].options.conversation.id,store.state.conversationId);
  await native.runs[0].finish();await next.idle();await next.close();
});
test('publication failure retains the same outbox revision for replacement and repairs the view',async t=>{
  const {root,h}=await fixture(t);await h.close();const native=new FakeClaude();let fail=true;
  const broken=harness(root,native,{}, {view:()=>fail});await assert.rejects(broken.activated,/view unavailable/);
  const original=(await disk(root)).outbox[0];assert.ok(original);
  await broken.close();fail=false;
  const repaired=harness(root,new FakeClaude());await repaired.activated;
  const retry=repaired.events.find(e=>e.type==='session.changed'&&e.revision===original.revision);
  assert.deepEqual(retry.state,original.view);assert.equal((await disk(root)).outbox.length,0);await repaired.close();
});
test('private task credentials disappear after completion and never enter projections',async t=>{
  const {root,native,h}=await fixture(t);const options={mcps:{private:{type:'http',url:'https://private.test',headers:{Authorization:'private-secret'}}}};
  await h.send({type:'input',id:'a',text:'A',settings:options});await until(()=>native.runs[0]?.inputs.length===1);
  assert.equal(JSON.stringify(h.views).includes('private-secret'),false);assert.equal(JSON.stringify(await disk(root)).includes('private-secret'),true);
  await native.runs[0].finish();await h.idle();assert.equal(JSON.stringify(await disk(root)).includes('private-secret'),false);
});
test('reset explicitly starts a fresh native conversation and preserves observed history',async t=>{
  const {native,h}=await fixture(t);await h.send({type:'input',id:'one',text:'One'});await until(()=>native.runs[0]?.inputs.length===1);
  await h.send({type:'reset'});assert.equal(h.replies.at(-1).code,'run_busy');
  await native.runs[0].finish('First answer');await h.idle();const previous=h.views.at(-1).conversationId;
  await h.send({type:'reset'});assert.notEqual(h.views.at(-1).conversationId,previous);assert.ok(h.views.at(-1).entries.some(e=>e.text==='First answer'));
  await h.send({type:'input',id:'two',text:'Two'});await until(()=>native.runs[1]?.inputs.length===1);
  assert.equal(native.runs[1].options.conversation.resumable,false);await native.runs[1].finish();await h.idle();
});
test('structured auth failure and missing native checkpoint remain visible in the durable view',async t=>{
  const {native,h}=await fixture(t);await h.send({type:'input',id:'auth',text:'Auth'});await until(()=>native.runs[0]?.inputs.length===1);
  native.runs[0].reject(new ClaudeAuthenticationRequired());await h.idle();
  assert.equal(h.views.at(-1).run.error,'authentication_required');assert.equal(h.views.at(-1).inputs[0].status,'failed');assert.ok(h.events.some(e=>e.type==='auth.required'));
  await h.send({type:'input',id:'missing',text:'Continue'});await until(()=>native.runs[1]?.inputs.length===1);
  native.runs[1].reject(new Error('native_resume_unavailable'));await h.idle();assert.equal(h.views.at(-1).run.error,'native_resume_unavailable');assert.equal(h.views.at(-1).inputs.at(-1).status,'failed');
});
test('validation and finishing backpressure reject input before durable admission',async t=>{
  const {root,native,h}=await fixture(t);
  for(const command of [{type:'input',id:'bad',text:''},{type:'input',id:'--bad',text:'x'},{type:'input',id:'big',text:'😀'.repeat(10000)}]){
    await h.send(command);assert.equal(h.replies.at(-1).code,'invalid_input');
  }
  await assert.rejects(h.send({type:'input',id:'settings',text:'x',settings:{binary:'/unsafe'}}));
  assert.equal((await disk(root)).messages.length,0);
  await h.send({type:'input',id:'one',text:'One'});await until(()=>native.runs[0]?.inputs.length===1);
  native.runs[0].accepting=false;await h.send({type:'input',id:'late',text:'Late'});
  assert.equal(h.replies.at(-1).code,'run_finishing');assert.equal((await disk(root)).messages.length,1);
  native.runs[0].reject(Error('closed'));await h.idle();
});
test('configuration is snapshotted and each run gets its own lifetime signal',async t=>{
  const settings={model:'sonnet',tools:['Read']}, {native,h}=await fixture(t,settings);settings.tools.push('Write');
  await h.send({type:'input',id:'a',text:'A'});await until(()=>native.runs[0]?.inputs.length===1);
  assert.deepEqual(native.runs[0].options.tools,['Read']);assert.notEqual(native.runs[0].context.signal,h.lifetime.signal);
  assert.equal(h.behaviour.redelivery,true);await native.runs[0].finish();await h.idle();
});

test('platform cancellation repairs the view through a fresh internal operation',async t=>{
  const {native,h}=await fixture(t);await h.send({type:'input',id:'a',text:'A'});await until(()=>native.runs[0]?.inputs.length===1);
  assert.equal(h.base.activity.cancel(),true);await h.idle();
  assert.equal(h.views.at(-1).run.status,'cancelled');assert.equal(h.views.at(-1).inputs[0].status,'cancelled');
});

test('reset and cancellation receipts survive retries without targeting a later run',async t=>{
  const {native,h}=await fixture(t);
  await h.send({type:'reset'},'reset-command');const first=h.replies.at(-1).conversationId;
  await h.send({type:'reset'},'reset-command');assert.equal(h.replies.at(-1).conversationId,first);
  await h.send({type:'input',id:'a',text:'A'});await until(()=>native.runs[0]?.inputs.length===1);
  await h.send({type:'cancel'},'cancel-command');await h.idle();
  await h.send({type:'input',id:'b',text:'B'});await until(()=>native.runs[1]?.inputs.length===1);
  await h.send({type:'cancel'},'cancel-command');assert.equal(native.runs[1].accepting,true);
  await h.send({type:'reset'},'reset-command');assert.equal(h.replies.at(-1).conversationId,first);assert.equal(native.runs[1].accepting,true);
  await native.runs[1].finish();await h.idle();
});
