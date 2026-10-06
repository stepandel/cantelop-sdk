import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceDatabase, validateDatabaseCredentials } from "../dist/database.js";
import { createSessionDatabase } from "../dist/session.js";
import { createRemoteApp } from "../dist/remote-app.js";
const url = "libsql://workspace-cantelop.turso.io";
function fixture() {
  let now = Date.now(); let resolutions = 0; const clients = [];
  const db = createWorkspaceDatabase(async () => ({ url, authToken:`token-${++resolutions}`, expiresAt:new Date(now+900000).toISOString() }), {
    now:()=>now,
    client:config=> {
      const client = { config, closed:false, writes:0,
        async execute() { this.writes++; return { rows:[],rowsAffected:1 }; },
        async transaction() { return { closed:false, execute:()=>client.execute(), async commit(){ this.closed=true; }, async rollback(){ this.closed=true; }, close(){ this.closed=true; } }; },
        close(){ this.closed=true; },
      }; clients.push(client); return client;
    },
  });
  return { db, clients, advance:()=>now+=850000, get resolutions(){return resolutions;} };
}
test("concurrent first use shares credentials; renewal leaves an active transaction intact", async () => {
  const f = fixture();
  await Promise.all([f.db.execute("SELECT 1"), f.db.execute("SELECT 1")]);
  assert.equal(f.resolutions,1);
  const tx = await f.db.transaction();
  f.advance(); await f.db.execute("SELECT 1");
  assert.equal(f.resolutions,2); assert.equal(f.clients[0].closed,false);
  await tx.execute("INSERT INTO state VALUES (1)"); await tx.commit();
  assert.equal(f.clients[0].closed,true); assert.equal(tx.closed,true);
  f.db.close(); assert.equal(f.clients[1].closed,true);
  await assert.rejects(f.db.execute("SELECT 1"),/client_closed/);
});
test("an ambiguous write failure is never replayed", async () => {
  let writes=0;
  const db=createWorkspaceDatabase(async()=>({url,authToken:"token",expiresAt:new Date(Date.now()+900000).toISOString()}),{
    client:()=>({async execute(){ writes++; throw new Error("connection lost after commit"); },close(){} }),
  });
  await assert.rejects(db.execute("INSERT INTO state VALUES (1)"),/connection lost/); assert.equal(writes,1); db.close();
});
test("credential destinations and expiry are validated", () => {
  const credentials={url,authToken:"token",expiresAt:new Date(Date.now()+900000).toISOString()};
  for(const bad of ["file:/tmp/db.sqlite","http://workspace-cantelop.turso.io","https://evil.example.com","libsql://user:pass@workspace-cantelop.turso.io"]) {
    assert.throws(()=>validateDatabaseCredentials({...credentials,url:bad}));
  }
  assert.throws(()=>validateDatabaseCredentials({...credentials,expiresAt:new Date().toISOString()}));
});
test("API Workspace uses the trusted credential route with its canonical ID",async()=>{
  const workspaceId="wsp_0123456789abcdef0123456789abcdef"; const calls=[];
  const app=createRemoteApp({fetch:async request=>{
    calls.push(request);
    if(request.url.endsWith("/workspaces/open")) return Response.json({id:workspaceId,app_id:"app_0123456789abcdef0123456789abcdef",slug:"default",hostname:"default--agent.cantelop.dev",created_at:"2026-10-05T00:00:00Z",updated_at:"2026-10-05T00:00:00Z"});
    assert.deepEqual(await request.json(),{workspace_id:workspaceId});
    return Response.json({url,authToken:"database-token",expiresAt:new Date(Date.now()+900000).toISOString()});
  }});
  const workspace=await app.workspaces.open({slug:"default"}); const db=await workspace.database();
  assert.equal((await db.credentials()).url,url);
  assert.equal(calls[1].url,"https://runtime.cantelop.internal/__cantelop/v1/workspaces/database/credentials"); db.close();
});
test("Session credentials use platform capability without accepting a Workspace selector",async()=>{
  const db=createSessionDatabase({CANTELOP_WORKSPACE_DATABASE_CREDENTIALS_URL:"https://console.cantelop.dev/internal/v1/runtime/database/credentials",CANTELOP_WORKSPACE_DATABASE_ACCESS_TOKEN:"sandbox-only"},async(url,init)=>{
    assert.equal(init.headers.Authorization,"Bearer sandbox-only"); assert.equal(init.body,undefined); assert.equal(init.redirect,"error");
    return Response.json({url:"libsql://workspace-cantelop.turso.io",authToken:"database-token",expiresAt:new Date(Date.now()+900000).toISOString()});
  });
  assert.equal((await db.credentials()).authToken,"database-token");db.close();
});

test("renewal failure reuses credentials only while they remain unexpired", async () => {
  for (const expireDuringRenewal of [false, true]) {
    let now = Date.now();
    const expiresAt = now + 900000;
    let resolutions = 0;
    let writes = 0;
    const db = createWorkspaceDatabase(async () => {
      if (++resolutions > 1) {
        if (expireDuringRenewal) now = expiresAt;
        throw new Error("credential service unavailable");
      }
      return { url, authToken: "token", expiresAt: new Date(expiresAt).toISOString() };
    }, { now: () => now, client: () => ({
      async execute() { writes++; return { rows: [], rowsAffected: 1 }; },
      close() {},
    }) });
    await db.execute("SELECT 1");
    now += 850000;
    if (expireDuringRenewal) {
      await assert.rejects(db.execute("INSERT INTO state VALUES (1)"), /credential service unavailable/);
      assert.equal(writes, 1);
    } else {
      await db.execute("INSERT INTO state VALUES (1)");
      assert.equal(writes, 2);
    }
    db.close();
  }
});

test("local database credentials require an explicit, exact development origin", () => {
  const local="http://127.0.0.1:32100";
  const credentials={url:local+"/databases/wsp_0123456789abcdef0123456789abcdef/",authToken:"local-token",expiresAt:new Date(Date.now()+900000).toISOString()};
  assert.throws(()=>validateDatabaseCredentials(credentials));
  assert.equal(validateDatabaseCredentials(credentials,Date.now(),local).url,credentials.url);
  for(const bad of ["http://127.0.0.1:32101","http://localhost:32100","http://evil.example:32100","http://127.0.0.1:32100/path","http://user@127.0.0.1:32100"]) {
    assert.throws(()=>validateDatabaseCredentials(credentials,Date.now(),bad));
  }
  for(const suffix of ["../other/","wsp_invalid/","wsp_0123456789abcdef0123456789abcdef/?x=1"]) {
    assert.throws(()=>validateDatabaseCredentials({...credentials,url:local+"/databases/"+suffix},Date.now(),local));
  }
});

test("Session local origin is opt-in and must match its credential broker", async () => {
  for(const origin of ["http://127.0.0.1:32100","http://host.docker.internal:32100"]) {
    const environment={CANTELOP_LOCAL_DATABASE_ORIGIN:origin,CANTELOP_WORKSPACE_DATABASE_CREDENTIALS_URL:origin+"/internal/v1/runtime/database/credentials",CANTELOP_WORKSPACE_DATABASE_ACCESS_TOKEN:"session-token"};
    const request=async()=>Response.json({url:origin+"/databases/wsp_0123456789abcdef0123456789abcdef/",authToken:"local-token",expiresAt:new Date(Date.now()+900000).toISOString()});
    const db=createSessionDatabase(environment,request);
    assert.equal((await db.credentials()).authToken,"local-token"); db.close();
    const {CANTELOP_LOCAL_DATABASE_ORIGIN,...hosted}=environment;
    await assert.rejects(createSessionDatabase(hosted,request).credentials(),/invalid_runtime_configuration/);
    await assert.rejects(createSessionDatabase({...environment,CANTELOP_WORKSPACE_DATABASE_CREDENTIALS_URL:"http://127.0.0.1:1/internal/v1/runtime/database/credentials"},request).credentials(),/invalid_runtime_configuration/);
  }
});
