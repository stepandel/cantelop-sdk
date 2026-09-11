import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { runSubprocess } from '../examples/supervised-activity/subprocess.mjs';
import { createSessionRuntimeHandler } from '../dist/runtime.js';
const sandbox='sbx-'+'1'.repeat(32), message='msg_'+'2'.repeat(32);
const pause=()=>new Promise(r=>setTimeout(r,5));
const until=async fn=>{for(let i=0;i<400;i++){if(await fn())return;await pause();}assert.fail('condition not reached');};

for(const scenario of ['startup failure','unexpected exit','stdout and stderr','output backpressure','cancellation']) {
 test(`Bun subprocess: ${scenario}`,{skip:!process.versions.bun,timeout:10000},async t=>{
  let outcome, failure, pid;
  const server=createServer(createSessionRuntimeHandler({receive(ctx){
   ctx.activity.start(async activity=>{
    const code=scenario==='cancellation'?'setInterval(()=>{},1000)':scenario==='unexpected exit'?'process.exit(23)':scenario==='stdout and stderr'?"console.log('out');console.error('err')":"console.log('ready');setInterval(()=>console.log('running'),10)";
    const argv=scenario==='startup failure'?['/nonexistent/cantelop-test-command']:[process.execPath,'-e',code];
    // Track the actual child for reaping checks while retaining the real Bun API.
    const original=Bun.spawn;
    Bun.spawn=(...args)=>{const child=original(...args);pid=child.pid;return child;};
    try {await runSubprocess(argv,activity);outcome='completed';}
    catch(error){failure=error;outcome=activity.signal.aborted?'cancelled':'failed';throw error;}
    finally {Bun.spawn=original;}
   });
  }},{sandboxId:sandbox}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{if(pid){try{process.kill(pid,'SIGKILL')}catch{}}server.closeAllConnections();server.close();});
  const request=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}/__cantelop/v2/${path}`,{method:body?'POST':'GET',headers:{'X-Cantelop-Sandbox-ID':sandbox,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  await request('messages',{session:{id:'test',workspace_id:'wsp_'+'3'.repeat(32),keep_alive_seconds:600},message:{id:message,payload:{}}});
  await until(async()=> (await(await request(`messages/${message}`)).json()).state==='succeeded');
  const events=[]; let cursor=0;
  if(scenario==='stdout and stderr'){
   await until(async()=>{
    const batch=await(await request(`runtime/events?after=${cursor}&wait=0`)).json();
    events.push(...batch.events);
    if(batch.events.length){cursor=batch.events.at(-1).cursor;await request('runtime/events/ack',{through:cursor});}
    return outcome!==undefined;
   });
   assert.equal(outcome,'completed');
   assert(events.some(e=>JSON.stringify(e).includes('out')));
   assert(events.some(e=>JSON.stringify(e).includes('err')));
  } else if(scenario==='output backpressure'||scenario==='cancellation'){
   await until(()=>pid!==undefined);
   if(scenario==='output backpressure') await until(async()=> (await(await request('runtime')).json()).events.latest>0);
   for(let i=0;i<20;i++){
    const health=await(await request('runtime')).json();
    assert(health.activity,'activity remains supervised while output is unacknowledged');
   }
   const health=await(await request('runtime')).json();
   await request('runtime/activity/cancel',{activity_id:health.activity.id});
   await until(()=>outcome!==undefined);
   assert.equal(outcome,'cancelled');
   assert.throws(()=>process.kill(pid,0));
  } else {
   await until(()=>outcome!==undefined);
   assert.equal(outcome,'failed');
   if(scenario==='unexpected exit')assert.match(failure.message,/code=23/);
  }
  await until(async()=>!(await(await request('runtime')).json()).activity);
  assert.equal((await(await request(`messages/${message}`)).json()).state,'succeeded');
 });
}


test('Bun SDK process death makes inspection unreachable', {skip:!process.versions.bun,timeout:10000}, async t => {
 const runtime=new URL('../dist/runtime.js',import.meta.url).href;
 const code=`import {createServer} from 'node:http';
 import {createSessionRuntimeHandler} from ${JSON.stringify(runtime)};
 const server=createServer(createSessionRuntimeHandler({receive(){return new Promise(()=>{})}},{sandboxId:${JSON.stringify(sandbox)}}));
 server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`;
 const child=Bun.spawn([process.execPath,'-e',code],{stdout:'pipe',stderr:'inherit'});
 t.after(async()=>{if(child.exitCode===null)child.kill('SIGKILL');await child.exited;});
 const reader=child.stdout.getReader();
 const {value}=await reader.read();const port=Number(new TextDecoder().decode(value).trim());
 assert(port>0);
 const url=`http://127.0.0.1:${port}/__cantelop/v2/`;
 const headers={'X-Cantelop-Sandbox-ID':sandbox,'Content-Type':'application/json'};
 assert.equal((await fetch(url+'messages',{method:'POST',headers,body:JSON.stringify({session:{id:'test',workspace_id:'wsp_'+'3'.repeat(32),keep_alive_seconds:600},message:{id:message,payload:{}}})})).status,202);
 assert.equal((await fetch(url+'runtime',{headers})).status,200);
 child.kill('SIGKILL');await child.exited;
 await assert.rejects(fetch(url+'runtime',{headers}));
 assert.equal(child.signalCode,'SIGKILL');
});
