import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryActivity } from '../dist/activity.js';
import { createSupervisedAgent } from '../examples/supervised-activity/session.mjs';
const pause=()=>new Promise(r=>setTimeout(r,5));
const until=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await pause();}assert.fail('condition not reached');};

test('example persists outcomes, sends output, and queues follow-up prompts during work',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'activity-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const started=[],output=[],gates=[];let internal=0;
 const behaviour=createSupervisedAgent({outcomeDirectory:directory,run:async(prompt,ctx)=>{
  started.push(prompt);await ctx.output.send({text:prompt});
  if(prompt==='failure') throw Error('subprocess failed');
  await new Promise((resolve,reject)=>{gates.push(resolve);ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true});});
 }});
 const activity=new InMemoryActivity(payload=>receive('internal'+(++internal),payload),async(_,event)=>output.push(event));
 function receive(id,payload){return behaviour.receive({message:{id,payload},activity:{get active(){return activity.active},start(work,policy){activity.start(id,work,policy)},cancel(){return activity.cancel()}}});}
 receive('one',{type:'prompt',prompt:'first'});await until(()=>started.length===1);
 receive('two',{type:'prompt',prompt:'second'});assert.deepEqual(started,['first']);
 gates.shift()();await until(()=>started.length===2);
 assert.equal(JSON.parse(await readFile(join(directory,'one.json'))).outcome,'completed');
 receive('cancel',{type:'cancel'});await until(()=>!activity.active);
 assert.equal(JSON.parse(await readFile(join(directory,'two.json'))).outcome,'cancelled');
 assert.deepEqual(output,[{text:'first'},{text:'second'}]);
 receive('three',{type:'prompt',prompt:'failure'});await until(()=>!activity.active);
 assert.equal(JSON.parse(await readFile(join(directory,'three.json'))).outcome,'failed');
});

test('quiescence waits for durable activity follow-up admission', async () => {
 let commit;
 const pending = new Promise(resolve => { commit = resolve; });
 let admissionStarted = false;
 const activity = new InMemoryActivity(async () => { admissionStarted = true; await pending; }, async () => {});
 activity.start('message', context => context.send({ type: 'completed' }));
 await until(() => admissionStarted);
 assert.equal(activity.active, false);
 assert.equal(activity.isIdle, false);
 assert.ok(activity.snapshot());
 commit();
 await until(() => activity.isIdle);
 assert.equal(activity.snapshot(), null);
});
