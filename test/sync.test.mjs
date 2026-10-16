import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, unlink, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CantelopClient, WorkspaceSyncError } from '../dist/index.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { validSyncPath, validSyncRequest } from '../dist/sync.js';

const workspaceId='wsp_'+'1'.repeat(32);
process.env.CANTELOP_SYNC_HELPER ??= fileURLToPath(new URL('./fixtures/sync-helper.mjs',import.meta.url));
const hash=(data,executable=false)=>createHash('sha256').update(Buffer.from([executable?1:0])).update(data).digest('hex');
const item=(name,data,executable=false)=>({path:name,version:hash(data,executable),size:data.length,executable});
const fail=(code,status=409)=>Response.json({error:{code}},{status});
async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'cantelop-sync-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const state=await mkdtemp(path.join(tmpdir(),'cantelop-sync-state-'));t.after(()=>rm(state,{recursive:true,force:true}));
  process.env.CANTELOP_SYNC_STATE_HOME=state;
  const files=new Map(), calls=[];let online=true,writes=true,corrupt=false;
  const platform=async request=>{
    calls.push(request.clone());
    const url=new URL(request.url);
    assert.equal(request.headers.get('Authorization'),null);
    if(url.pathname.endsWith('/workspaces/'+workspaceId)) return Response.json({id:workspaceId,app_id:'app_'+'2'.repeat(32),slug:'project',hostname:'agent.cantelop.dev',created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z'});
    if(!online) throw new Error('offline');
    assert.equal(url.pathname,`/__cantelop/integration/v2/workspaces/${workspaceId}/sync`);
    const op=url.searchParams.get('op'),name=url.searchParams.get('path'),base=url.searchParams.get('base'),previous=files.get(name);
    const rootName=url.searchParams.get("root") ?? "project";
    if(op==='scan')return Response.json({protocolVersion:1,root:rootName,writes,entries:[...files].map(([name,f])=>item(name,f.data,f.executable))});
    if((previous?.version??'missing')!==base)return fail('sync_conflict');
    if(op==='read')return new Response(corrupt?Buffer.from('corrupt'):previous.data);
    if(op==='write'){
      if(!writes)return fail('sync_writes_not_enabled',503);
      const data=Buffer.from(await request.arrayBuffer()),executable=url.searchParams.get('executable')==='1';
      const entry=item(name,data,executable);files.set(name,{...entry,data});return Response.json(entry);
    }
    if(op==='remove'){files.delete(name);return new Response(null,{status:204});}
    throw new Error('unexpected operation');
  };
  const worker=createProtocolWorker({runtimeId:'test.v1',fetch:platform});
  const connection={fetch(request){const headers=new Headers(request.headers);headers.set('Authorization','Bearer app-token');headers.set('X-Untrusted','not-forwarded');return worker.fetch(new Request(request,{headers}),{CANTELOP_INTEGRATION_TOKEN:'app-token'});}};
  const app=new CantelopClient().app({name:'sync-test',runtime:{receive(){}},connection});
  const workspace=app.workspace({id:workspaceId});
  const start=async(options={})=>{const handle=await workspace.sync({localDirectory:root,pollIntervalMs:60000,...options});t.after(()=>handle.stop());return handle;};
  const put=(name,data,executable=false)=>{data=Buffer.from(data);files.set(name,{...item(name,data,executable),data});};
  return {root,state,files,calls,start,put,setOnline:v=>online=v,setWrites:v=>writes=v,setCorrupt:v=>corrupt=v};
}

test('one capability reconciles binary files, executable bits, creates and deletes both ways',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'src'));await writeFile(path.join(f.root,'src/local.bin'),Buffer.from([0,255,2]));
  f.put('remote.sh','#!/bin/sh\n',true);
  const sync=await f.start();await sync.ready();assert.equal(sync.status().state,'synced');
  assert.deepEqual(f.files.get('src/local.bin').data,Buffer.from([0,255,2]));
  assert.equal(await readFile(path.join(f.root,'remote.sh'),'utf8'),'#!/bin/sh\n');assert.ok((await stat(path.join(f.root,'remote.sh'))).mode&0o111);
  await writeFile(path.join(f.root,'src/local.bin'),'local edit');f.put('remote.sh','remote edit',true);await sync.flush();
  assert.equal(f.files.get('src/local.bin').data.toString(),'local edit');assert.equal(await readFile(path.join(f.root,'remote.sh'),'utf8'),'remote edit');
  await unlink(path.join(f.root,'src/local.bin'));f.files.delete('remote.sh');await sync.flush();
  assert.equal(f.files.size,0);await assert.rejects(readFile(path.join(f.root,'remote.sh')),{code:'ENOENT'});
});
test('relative directories scope every operation and retain their baseline across restart',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'README.md'),'local');f.put('remote','download');
  let sync=await f.start({remoteDirectory:'src/my project'});await sync.ready();
  assert.equal(sync.remoteDirectory,'/workspace/src/my project');assert.equal(f.files.get('README.md').data.toString(),'local');
  await unlink(path.join(f.root,'remote'));await sync.flush();
  const transfers=f.calls.filter(request=>new URL(request.url).pathname.endsWith('/sync'));
  assert.deepEqual(new Set(transfers.map(request=>new URL(request.url).searchParams.get('op'))),new Set(['scan','read','write','remove']));
  for(const request of transfers)assert.equal(new URL(request.url).searchParams.get('root'),'src/my project');
  await sync.stop();sync=await f.start({remoteDirectory:'src/my project'});await sync.ready();await sync.stop();
  await assert.rejects(f.start({remoteDirectory:'other'}),{code:'sync_invalid_state'});
  const metadata=(await readdir(f.state,{recursive:true})).find(name=>name.endsWith(workspaceId+'.json'));
  assert.equal(JSON.parse(await readFile(path.join(f.state,metadata),'utf8')).protocolVersion,2);
});
test('legacy baselines remain compatible and new roots cannot be reopened by the legacy SDK',async t=>{
  const f=await fixture(t);let sync=await f.start();await sync.ready();await sync.stop();
  const files=await readdir(f.state,{recursive:true});const filename=files.find(name=>name.endsWith(workspaceId+'.json'));
  assert.ok(filename);const stateFile=path.join(f.state,filename);const state=JSON.parse(await readFile(stateFile,'utf8'));
  assert.equal(state.protocolVersion,1);delete state.remoteDirectory;await writeFile(stateFile,JSON.stringify(state));
  sync=await f.start();await sync.ready();assert.equal(sync.remoteDirectory,'/workspace/project');
  const scan=f.calls.find(request=>new URL(request.url).searchParams.get('op')==='scan');assert.equal(new URL(scan.url).searchParams.has('root'),false);
});
test('explicit empty directory selects the whole Workspace without changing legacy defaults',async t=>{
  const f=await fixture(t);const sync=await f.start({remoteDirectory:''});await sync.ready();
  assert.equal(sync.remoteDirectory,'/workspace');assert.equal(sync.status().writable,true);
  const scan=f.calls.find(request=>new URL(request.url).searchParams.get('op')==='scan');
  assert.equal(new URL(scan.url).searchParams.get('root'),'');
  await sync.stop();await assert.rejects(f.start(),{code:'sync_invalid_state'});
});
test('relative roots use the generic path grammar and reject ambiguous requests',async t=>{
  const f=await fixture(t);
  for(const name of ['../outside','/absolute','a//b','.git','.ENV','NODE_MODULES','a\\b','a/']) {
    await assert.rejects(f.start({remoteDirectory:name}));
    assert.equal(validSyncRequest('GET',new URLSearchParams({op:'scan',root:name})),false);
  }
  for(const root of ['', 'src/my project', '.claude'])assert.equal(validSyncRequest('GET',new URLSearchParams({op:'scan',root})),true);
  assert.equal(validSyncRequest('POST',new URLSearchParams({op:'bind',directory:'my-project'})),false);
  assert.equal(validSyncRequest('GET',new URLSearchParams('op=scan&root=a&root=b')),false);
});
test('divergent edits and delete/edit conflicts preserve both sides and persist their common base',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'a'),'base');let sync=await f.start();await sync.ready();await sync.stop();
  await writeFile(path.join(f.root,'a'),'local');f.put('a','remote');sync=await f.start();
  await assert.rejects(sync.ready(),{code:'sync_conflict'});assert.equal(sync.status().state,'conflict');assert.equal(sync.status().conflicts[0].path,'a');
  assert.equal(await readFile(path.join(f.root,'a'),'utf8'),'local');assert.equal(f.files.get('a').data.toString(),'remote');
  await writeFile(path.join(f.root,'a'),'remote');await sync.flush();assert.equal(sync.status().state,'synced');
  await unlink(path.join(f.root,'a'));f.put('a','new remote');await assert.rejects(sync.flush(),{code:'sync_conflict'});assert.equal(f.files.get('a').data.toString(),'new remote');
});
test('initial reconciliation preserves unrelated remote content and refuses differing same-path files',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'same'),'local');f.put('same','remote');f.put('other','keep');
  const sync=await f.start();await assert.rejects(sync.ready(),{code:'sync_conflict'});
  assert.equal(await readFile(path.join(f.root,'other'),'utf8'),'keep');assert.equal(f.files.get('same').data.toString(),'remote');
});
test('offline changes reconcile after reconnect; a disabled write gate cannot report synced',async t=>{
  const f=await fixture(t);const sync=await f.start();await sync.ready();f.setOnline(false);await writeFile(path.join(f.root,'a'),'offline edit');
  await assert.rejects(sync.flush());assert.equal(sync.status().state,'offline');f.setOnline(true);f.setWrites(false);
  await assert.rejects(sync.flush(),{code:'sync_writes_not_enabled'});assert.equal(sync.status().state,'error');assert.equal(f.files.size,0);
  f.setWrites(true);await sync.flush();assert.equal(f.files.get('a').data.toString(),'offline edit');
});
test('reserved state, credentials and dependency directories never transfer',async t=>{
  const f=await fixture(t);for(const directory of ['node_modules','.git','.cantelop']){await mkdir(path.join(f.root,directory));await writeFile(path.join(f.root,directory,'secret'),'private');}
  await writeFile(path.join(f.root,'.env'),'secret');await writeFile(path.join(f.root,'ok'),'ok');const sync=await f.start({ignore:['.git','node_modules','.env']});await sync.ready();assert.deepEqual([...f.files.keys()],['ok']);
});
test('scans omit local links and downloads cannot follow them or escape the directory',async t=>{
  const f=await fixture(t);const outside=await mkdtemp(path.join(tmpdir(),'sync-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(path.join(outside,'secret'),'private');
  await symlink(outside,path.join(f.root,'escape'));const sync=await f.start();await sync.ready();assert.equal(f.files.size,0);
  f.put('escape/secret','attack');await assert.rejects(sync.flush());assert.equal(await readFile(path.join(outside,'secret'),'utf8'),'private');f.files.delete('escape/secret');
  await unlink(path.join(f.root,'escape'));f.put('../secret','attack');await assert.rejects(sync.flush());assert.equal(await readFile(path.join(outside,'secret'),'utf8'),'private');
});
test('checksum failures do not publish a downloaded file',async t=>{
  const f=await fixture(t);f.put('a','valid');f.setCorrupt(true);const sync=await f.start();await assert.rejects(sync.ready(),{code:'sync_checksum_mismatch'});await assert.rejects(readFile(path.join(f.root,'a')),{code:'ENOENT'});
});
test('one local directory has one sync owner and stop releases its lock',async t=>{
  const f=await fixture(t);const first=await f.start();await first.ready();await assert.rejects(f.start(),{code:'sync_locked'});await first.stop();await first.stop();
  const second=await f.start();await second.ready();await second.stop();assert.equal(second.status().state,'stopped');await assert.rejects(second.flush(),{code:'sync_stopped'});
});
test('case-colliding remote paths fail before any local file is published',async t=>{
  const f=await fixture(t);f.put('a','one');f.put('A','two');const sync=await f.start();await assert.rejects(sync.ready(),{code:'sync_case_collision'});assert.equal((await readdir(f.root)).filter(name=>!name.startsWith('.cantelop-sync-')).length,0);
});
test('sync Edge ingress authenticates every transfer and strips caller authority',async()=>{
  let calls=0;const worker=createProtocolWorker({runtimeId:'test.v1',fetch:async request=>{calls++;assert.deepEqual([...request.headers.keys()],['content-type']);return new Response(null,{status:204});}});
  const url=`https://agent.example/__cantelop/sync/workspaces/${workspaceId}?op=write&path=a&base=missing`;
  const bindings={CANTELOP_INTEGRATION_TOKEN:'token'};
  assert.equal((await worker.fetch(new Request(url,{method:'PUT',body:'secret'}),bindings)).status,401);assert.equal(calls,0);
  assert.equal((await worker.fetch(new Request(url,{method:'PUT',body:'ok',headers:{Authorization:'Bearer token',Cookie:'private','X-Cantelop-Edge-App-ID':'forged'}}),bindings)).status,204);assert.equal(calls,1);
  assert.equal((await worker.fetch(new Request(url+'&path=other',{method:'PUT',headers:{Authorization:'Bearer token'}}),bindings)).status,400);assert.equal(calls,1);
});
test('path and method grammar rejects escaping and ambiguous operations',()=>{
  for(const name of ['../a','/a','a//b','a\\b','.git/config','.env.secret','.cantelop-sync-lock'])assert.equal(validSyncPath(name),false);
  assert.equal(validSyncRequest('GET',new URLSearchParams('op=scan')),true);assert.equal(validSyncRequest('PUT',new URLSearchParams('op=scan')),false);
  assert.equal(validSyncRequest('PUT',new URLSearchParams('op=write&path=a&base=missing&base=missing')),false);
});
