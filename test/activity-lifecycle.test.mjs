import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryActivity } from '../dist/activity.js';
import { createSessionRuntimeHandler } from '../dist/runtime.js';
import { createServer } from 'node:http';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('activity records start, failure, completion and cooperative cancellation separately', async () => {
 for (const outcome of ['completed', 'failed', 'cancelled']) {
  const records = [];
  const activity = new InMemoryActivity(() => {}, async () => {});
  activity.start('origin', async ({signal}) => {
   if (outcome === 'failed') throw new Error('private failure');
   if (outcome === 'cancelled') await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
  }, {}, event => records.push(event));
  await tick();
  if (outcome === 'cancelled') {activity.cancel(); activity.cancel();}
  await tick();
  assert.equal(activity.active, false);
  assert.deepEqual(records.map(x=>x.outcome), outcome === 'cancelled' ? ['started','cancellation_requested','cancelled'] : ['started',outcome]);
  assert(records.every(x=>x.messageId==='origin' && x.activityId === records[0].activityId));
 }
});

test('uncooperative cancellation stays active until settlement; telemetry cannot break work', async () => {
 let finish;
 const activity = new InMemoryActivity(()=>{},async()=>{});
 const records=[];
 activity.start('origin',()=>new Promise(r=>finish=r),{},e=>{records.push(e.outcome);throw Error('telemetry unavailable')});
 await tick();activity.cancel();
 assert.equal(activity.active,true);
 assert.deepEqual(records,['started','cancellation_requested']);
 finish();await tick();
 assert.equal(activity.active,false);
 assert.equal(records.at(-1),'cancelled');
});

test('failed activity telemetry preserves successful originating message receipt', async t => {
 let reject;
 const server=createServer(createSessionRuntimeHandler({receive(ctx){ctx.activity.start(()=>new Promise((_,r)=>reject=r));}},{sandboxId:'sbx-'+'1'.repeat(32)}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const message='msg_'+'2'.repeat(32);
 const request=async(path,body)=>fetch(`http://127.0.0.1:${server.address().port}/__cantelop/v2/${path}`,{method:body?'POST':'GET',headers:{'X-Cantelop-Sandbox-ID':'sbx-'+'1'.repeat(32),'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
 await request('messages',{session:{id:'test',workspace_id:'wsp_'+'3'.repeat(32),keep_alive_seconds:600},message:{id:message,payload:{}},observability:{attempt_id:'att_'+'4'.repeat(32),attempt:1,traceparent:'00-'+'5'.repeat(32)+'-'+'6'.repeat(16)+'-01'}});
 for(let i=0;!reject&&i<100;i++) await tick();
 assert(reject);reject(Error('private failure'));
 await tick();
 assert.equal((await(await request(`messages/${message}`)).json()).state,'succeeded');
 const events=(await(await request('runtime/observations?after=0&wait=0')).json()).observations;
 const activity=events.filter(e=>e.observation.attributes?.source==='activity');
 assert.deepEqual(activity.map(e=>e.observation.attributes.outcome),['started','failed']);
 assert(activity.every(e=>e.message_id===message));
 assert(!JSON.stringify(activity).includes('private failure'));
});


test('internal activities without attempt context still emit sandbox-scoped lifecycle records', async () => {
 const {RuntimeObserver, RuntimeObservationBuffer}=await import('../dist/observability.js');
 const buffer=new RuntimeObservationBuffer();
 const observer=new RuntimeObserver('internal-message',undefined,buffer);
 observer.recordActivity({activityId:'activity',messageId:'internal-message',outcome:'failed'});
 const events=await buffer.read(0,undefined,false,false);
 assert.equal(events.length,1);
 assert.equal(events[0].messageId,undefined);
 assert.equal(events[0].observation.attributes.message_id,'internal-message');
 assert.equal(events[0].observation.attributes.outcome,'failed');
});
