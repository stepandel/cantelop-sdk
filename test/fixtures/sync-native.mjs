// Invoked by the platform's TestWorkspaceSyncSDK against its actual Go service.
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CantelopClient } from '../../dist/index.js';
import { createProtocolWorker } from '../../dist/protocol-edge.js';

const [origin,local,remote]=process.argv.slice(2),id='wsp_'+'1'.repeat(32);
const worker=createProtocolWorker({runtimeId:'test.v1',fetch:async request=>{
  const url=new URL(request.url);
  if(url.pathname.endsWith('/workspaces/'+id))return Response.json({id,app_id:'app_'+'2'.repeat(32),slug:'project',hostname:'agent.example',created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z'});
  assert.equal(url.pathname,`/__cantelop/integration/v2/workspaces/${id}/sync`);
  assert.equal(request.headers.get('Authorization'),null);
  return fetch(new URL('/'+url.search,origin),{method:request.method,signal:request.signal,...(request.body?{body:await request.arrayBuffer()}:{}),redirect:'error'});
}});
const app=new CantelopClient().app({name:'native-sync-test',runtime:{receive(){}},connection:{fetch:request=>{
  const headers=new Headers(request.headers);headers.set('Authorization','Bearer fixture-token');
  return worker.fetch(new Request(request,{headers}),{CANTELOP_INTEGRATION_TOKEN:'fixture-token'});
}}});
await writeFile(path.join(local,'binary'),Buffer.from([0,255,0,42]));
let sync=await app.workspace({id}).sync({localDirectory:local,pollIntervalMs:60000});
try{
  await sync.ready();assert.deepEqual(await readFile(path.join(remote,'binary')),Buffer.from([0,255,0,42]));
  await writeFile(path.join(remote,'agent.sh'),'remote edit',{mode:0o755});await sync.flush();assert.equal(await readFile(path.join(local,'agent.sh'),'utf8'),'remote edit');
  await writeFile(path.join(local,'binary'),'local edit');await sync.flush();assert.equal(await readFile(path.join(remote,'binary'),'utf8'),'local edit');
  await sync.stop();await writeFile(path.join(local,'binary'),'offline local');await writeFile(path.join(remote,'binary'),'offline remote');
  sync=await app.workspace({id}).sync({localDirectory:local,pollIntervalMs:60000});await assert.rejects(sync.ready(),{code:'sync_conflict'});
  assert.equal(await readFile(path.join(local,'binary'),'utf8'),'offline local');assert.equal(await readFile(path.join(remote,'binary'),'utf8'),'offline remote');
  await writeFile(path.join(local,'binary'),'offline remote');await sync.flush();
  await unlink(path.join(local,'binary'));await sync.flush();await assert.rejects(readFile(path.join(remote,'binary')),{code:'ENOENT'});
  await unlink(path.join(remote,'agent.sh'));await sync.flush();await assert.rejects(readFile(path.join(local,'agent.sh')),{code:'ENOENT'});
  assert.equal(sync.status().state,'synced');
}finally{await sync.stop();}
