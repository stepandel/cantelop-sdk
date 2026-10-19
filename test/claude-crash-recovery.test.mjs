import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
const worker=new URL('./fixtures/claude-runtime-crash-worker.mjs',import.meta.url);
function launch(root,mode){
  const messages=[];let stderr='';
  const child=fork(worker,[root,mode],{stdio:['ignore','ignore','pipe','ipc']});
  child.on('message',m=>messages.push(m));child.stderr.on('data',c=>stderr+=c);
  return {child,async message(type){
    const deadline=Date.now()+8000;
    while(!messages.some(m=>m.type===type)){
      assert.equal(child.exitCode,null,stderr);assert.ok(Date.now()<deadline,stderr||'worker timed out');await new Promise(r=>setTimeout(r,5));
    }
    return messages.find(m=>m.type===type);
  },async kill(){if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await stopped;}}};
}
for(const mode of ['admit','stream'])test(`SIGKILL at ${mode} boundary preserves input and observations without unsafe replay`,async t=>{
  const root=await mkdtemp('/tmp/claude-crash-recovery-');let first,next;
  t.after(async()=>{await first?.kill();await next?.kill();await rm(root,{recursive:true,force:true});});
  first=launch(root,mode);const boundary=await first.message('boundary');await first.kill();
  next=launch(root,'recover');const restored=await next.message('restored');
  assert.equal(restored.effects,1);
  if(mode==='admit'){
    assert.equal(restored.state.inputs[0].status,'completed');assert.ok(restored.state.entries.some(e=>e.text==='Recovered safe delivery'));
  }else{
    assert.equal(restored.state.inputs[0].status,'interrupted');
    assert.ok(restored.state.entries.some(e=>e.text==='CRASH_OBSERVATION_SENTINEL'));
    assert.ok(restored.observed.some(e=>e.type==='session.changed'&&e.revision===boundary.revision));
  }
});
