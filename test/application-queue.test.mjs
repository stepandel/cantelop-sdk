import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { InMemoryActivity } from "../dist/activity.js";
import { createPersistentAgent } from "../examples/application-queue/session.mjs";

const until = async predicate => {
  for (let n=0;n<100;n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,5)); }
  assert.fail("condition not reached");
};

test("application queue commits intake once, steers busy work, and restores checkpoints", async t => {
  const directory = await mkdtemp(join(tmpdir(), "application-queue-"));
  const db = createClient({ url: `file:${directory}/queue.db` });
  t.after(() => rm(directory, {recursive:true,force:true}));
  t.after(() => db.close());
  const starts = [], steers = [];
  let finish;
  const behaviour = createPersistentAgent({
    async run(prompt, context) {
      starts.push({ prompt, checkpoint:context.checkpoint, steers:context.steers });
      await context.saveCheckpoint({ position:1 });
      return new Promise((resolve,reject) => {
        finish = resolve;
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once:true });
      });
    },
    steer(prompt) { steers.push(prompt); },
  });
  let serial = 0;
  const activity = new InMemoryActivity(payload => receive(`wake-${++serial}`,payload),async () => {});
  const context = { session:{id:"session-a"}, database:async () => db, activity:{ get active(){return activity.active;},start(work){activity.start("origin",work);},cancel(){return activity.cancel();} }};
  const receive = (id,payload) => behaviour.receive({...context,message:{id,payload}});
  await behaviour.onActivate(context);
  await receive("one",{type:"prompt",prompt:"first"});
  await until(() => starts.length===1 && finish);
  await receive("one",{type:"prompt",prompt:"first"});
  assert.equal((await db.execute("SELECT count(*) AS n FROM app_jobs")).rows[0].n,1);
  await receive("steer",{type:"steer",prompt:"change direction"});
  await receive("steer",{type:"steer",prompt:"change direction"});
  assert.deepEqual(steers,["change direction"]);
  await assert.rejects(receive("one",{type:"prompt",prompt:"conflict"}),/identity conflict/);
  // Simulate process loss after checkpoint persistence. The aborted worker leaves
  // its job running; a replacement application explicitly restores it.
  activity.cancel();
  await until(() => activity.isIdle);
  const replacement = createPersistentAgent({async run(prompt, restored) {
    assert.equal(prompt,"first");
    assert.deepEqual(restored.checkpoint,{position:1});
    assert.deepEqual(restored.steers,["change direction"]);
    return "restored";
  }});
  const nextActivity = new InMemoryActivity(async () => {},async () => {});
  await replacement.onActivate({...context,activity:{get active(){return nextActivity.active;},start(work){nextActivity.start("replacement",work);},cancel(){return nextActivity.cancel();}}});
  await until(async () => (await db.execute("SELECT state FROM app_jobs")).rows[0].state==="done");
  assert.equal((await db.execute("SELECT result FROM app_jobs")).rows[0].result,'"restored"');
});

test("cancel persists application intent before aborting active work", async t => {
  const directory=await mkdtemp(join(tmpdir(),"application-cancel-"));
  const db=createClient({url:`file:${directory}/queue.db`}); t.after(()=>db.close()); t.after(()=>rm(directory,{recursive:true,force:true}));
  let started=false;
  const behaviour=createPersistentAgent({async run(_, {signal}){
    started=true;
    await new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
  }});
  let n=0;
  const activity=new InMemoryActivity(payload=>receive(`wake-${++n}`,payload),async()=>{});
  const context={session:{id:"session"},database:async()=>db,activity:{get active(){return activity.active;},start(work){activity.start("origin",work);},cancel(){return activity.cancel();}}};
  const receive=(id,payload)=>behaviour.receive({...context,message:{id,payload}});
  await behaviour.onActivate(context);
  await receive("one",{type:"prompt",prompt:"run"}); await until(()=>started);
  await receive("two",{type:"prompt",prompt:"queued"});
  await receive("cancel",{type:"cancel"}); await until(()=>activity.isIdle);
  assert.deepEqual((await db.execute("SELECT state FROM app_jobs ORDER BY sequence")).rows.map(row=>row.state),["cancelled","cancelled"]);
});
