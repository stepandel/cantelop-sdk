import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTH_SESSION_ID, NATIVE_AUTH_CONTRACT } from "../dist/native-auth.js";
import { CantelopClient } from "../dist/index.js";
import { createProtocolWorker } from "../dist/protocol-edge.js";
import { validateCompatibility } from "../dist/compatibility.js";
import { buildAppArtifacts } from "../dist/build.js";

const workspace = "wsp_" + "1".repeat(32), id = "msg_" + "2".repeat(32);
const bindings = { CANTELOP_INTEGRATION_TOKEN: "test", CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS: "300" };
function request(version, runtime = "old.build", command = { type: "dispatch", message: "hello" }) {
  return new Request(`https://app.example/commands/${command.type}`, { method: "POST", headers: {
    Authorization: "Bearer test", "Content-Type": "application/json", "X-Cantelop-Session-Runtime": runtime,
    ...(version === undefined ? {} : { "X-Cantelop-Session-Contract": version }),
  }, body: JSON.stringify({ protocolVersion: 2, id, workspace: { id: workspace }, session: { id: command.type === "auth" ? AUTH_SESSION_ID : "thread" }, command }) });
}

test("compatible builds accept old and new clients in either deployment order", async () => {
  for (const deployedBuild of ["old.build", "new.build"]) {
    const calls = [];
    const worker = createProtocolWorker({ runtimeId: deployedBuild, compatibility: { version: "1" }, fetch: async req => {
      calls.push(await req.json()); return Response.json({ id, status: "accepted", accepted_at: new Date().toISOString() }, { status: 202 });
    } });
    for (const clientBuild of ["old.build", "new.build"]) {
      assert.equal((await worker.fetch(request("1", clientBuild), bindings)).status, 202);
      assert.equal(calls.at(-1).session.contract_version, "1");
      assert.deepEqual(calls.at(-1).message.payload, { __cantelop_command: 2, type: "dispatch", message: "hello" });
    }
  }
});

test("breaking versions, unknown legacy builds, and downgrade attempts never dispatch", async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: "new.build", compatibility: { version: "2", accepts: ["1"], legacyRuntimes: { "old.build": "1" } }, fetch: async () => { calls++; return Response.json({}); } });
  for (const [version, runtime] of [["3", "old.build"], [undefined, "unknown.build"], ["", "new.build"]]) {
    const response = await worker.fetch(request(version, runtime), bindings);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "session_contract_mismatch");
  }
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(request(undefined), bindings)).status, 200);
  assert.equal((await worker.fetch(request("1", "future.build"), bindings)).status, 200);
});

test("strict Apps retain fingerprint checks and do not silently opt in", async () => {
  const worker = createProtocolWorker({ runtimeId: "new.build", auth: true, fetch: async () => { throw Error("must not dispatch"); } });
  const auth = { type: "auth", auth: { type: "status" }, timeoutMs: 1000 };
  // A matching fingerprint is not the problem when the deployment never declared contracts.
  for (const [version, runtime, command, code] of [
    ["1", "new.build", undefined, "session_contract_not_declared"],
    [undefined, "old.build", undefined, "session_runtime_mismatch"],
    [undefined, "old.build", auth, "session_runtime_mismatch"],
  ]) {
    const response = await worker.fetch(request(version, runtime, command), bindings);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, code);
  }
});

test("compatibility declarations reject values that would silently drop entries or claim native auth", () => {
  class Mapping { constructor() { this["old.build"] = "1"; } }
  class Declaration { constructor() { this.version = "1"; } }
  for (const compatibility of [
    {version:""}, {version:"1", accepts:["1","1"]}, {version:"1", accepts:["bad version"]}, {version:"1", legacyRuntimes:{"old.build":"2"}}, {version:"1", extra:true},
    {version:"1", accepts:null}, {version:"1", legacyRuntimes:null}, {version:"1", legacyRuntimes:new Map([["old.build","1"]])}, {version:"1", legacyRuntimes:new Mapping()},
    new Declaration(), null, {version:NATIVE_AUTH_CONTRACT}, {version:"Native-Auth.v2"}, {version:"2", accepts:[NATIVE_AUTH_CONTRACT]},
  ]) assert.throws(() => validateCompatibility(compatibility), TypeError);
  // The compiler produces null-prototype literals; they remain valid declarations.
  const legacyRuntimes = Object.assign(Object.create(null), { "old.build": "1" });
  assert.deepEqual({ ...validateCompatibility({ version: "1", legacyRuntimes }).legacyRuntimes }, { "old.build": "1" });
});

test("native auth is never blocked by App contract negotiation", async () => {
  const contracts = [];
  const worker = createProtocolWorker({ runtimeId: "new.build", auth: true, compatibility: { version: "2", legacyRuntimes: {} }, fetch: async req => {
    contracts.push((await req.json()).session.contract_version);
    return Response.json({ id, reply: { type: "status", authenticated: true } });
  } });
  const auth = { type: "auth", auth: { type: "status" }, timeoutMs: 1000 };
  for (const [version, runtime] of [["1", "old.build"], [undefined, "unknown.build"], ["3", "future.build"]])
    assert.equal((await worker.fetch(request(version, runtime, auth), bindings)).status, 200);
  assert.deepEqual(contracts, [NATIVE_AUTH_CONTRACT, NATIVE_AUTH_CONTRACT, NATIVE_AUTH_CONTRACT]);
  // The same client is still rejected for App Session commands.
  const response = await worker.fetch(request("1", "old.build"), bindings);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "session_contract_mismatch");
  assert.equal(contracts.length, 3);
});

test("versioned reads carry the client contract through every private route", async () => {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: "new.build", compatibility: { version: "2", accepts: ["1"] }, fetch: async req => {
    calls.push(new URL(req.url)); return Response.json({});
  } });
  for (const command of [{ type: "view" }, { type: "status", messageId: id }, { type: "stream" }]) {
    assert.equal((await worker.fetch(request("1", "old.build", command), bindings)).status, 200);
    assert.equal(calls.at(-1).searchParams.get("contract_version"), "1");
    assert.equal(calls.at(-1).searchParams.get("workspace_id"), workspace);
  }
  assert.deepEqual(calls.map(url => url.pathname), [
    "/__cantelop/integration/v2/sessions/thread/view",
    `/__cantelop/integration/v2/sessions/thread/messages/${id}`,
    "/__cantelop/integration/v2/sessions/thread/events",
  ]);
});

test("SDK stamps contract identity and native auth has its own stable contract", async () => {
  let seen;
  const client = new CantelopClient().app({ name: "app", runtime: {receive(){}}, compatibility: {version:"1"}, connection: {fetch: async req => {
    seen = req.headers.get("X-Cantelop-Session-Contract");
    const body = await req.json(); return Response.json({protocolVersion:2,id:body.id,status:"accepted",accepted_at:new Date().toISOString()});
  }} });
  await client.workspace({id:workspace}).session({id:"thread"}).dispatch("hello");
  assert.equal(seen,"1");
  const worker = createProtocolWorker({ runtimeId:"new.build", auth:true, compatibility:{version:"2",accepts:["1"]}, fetch:async req => {
    const body = await req.json(); assert.equal(body.session.contract_version,"native-auth.v1");
    return Response.json({id,reply:{type:"status",authenticated:false}});
  }});
  assert.equal((await worker.fetch(request("1","old.build",{type:"auth",auth:{type:"status"},timeoutMs:1000}),bindings)).status,200);
});

test("compiler keeps compatibility metadata across client, Edge and native artifacts", async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"cantelop-contract-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const definition = path.join(directory,"app.mts");
  const compatibility = {version:"2", accepts:["1"], legacyRuntimes:{"old.build":"1"}};
  const source = body => `import {CantelopClient} from ${JSON.stringify(new URL("../dist/client.js",import.meta.url).pathname)}; export const app = new CantelopClient().app({name:"app",compatibility:${JSON.stringify(compatibility)},runtime:{receive(){${body}}}});`;
  await writeFile(definition,source(""));
  const first = await buildAppArtifacts({definition,outdir:path.join(directory,"a")});
  await writeFile(definition,source('console.log("new implementation")'));
  const second = await buildAppArtifacts({definition,outdir:path.join(directory,"b")});
  assert.notEqual(first.apps[0].edge.manifest.session_runtime_id,second.apps[0].edge.manifest.session_runtime_id);
  for (const result of [first,second]) for (const manifest of [result.apps[0].edge.manifest,result.apps[0].runtime.manifest,result.backend.manifest.apps[0]])
    assert.deepEqual(manifest.compatibility,compatibility);
});

test("compiler rejects compatibility declarations it cannot extract", async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"cantelop-contract-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const client = JSON.stringify(new URL("../dist/client.js",import.meta.url).pathname);
  for (const [index, [declaration, option, message]] of [
    ['const compatibility = { version: "1" };', "compatibility", /App compatibility must be an inline literal value/],
    ['const environment = { TOKEN: { secret: true } };', "environment", /App environment must be an inline literal value/],
    ["", '["compatibility"]: { version: "1" }', /App options must use literal property names/],
  ].entries()) {
    const definition = path.join(directory,`app-${index}.mts`);
    await writeFile(definition,`import {CantelopClient} from ${client};\n${declaration}\nexport const app = new CantelopClient().app({name:"app", ${option}, runtime:{receive(){}}});\n`);
    await assert.rejects(buildAppArtifacts({definition,outdir:path.join(directory,`out-${index}`)}), message);
  }
});
