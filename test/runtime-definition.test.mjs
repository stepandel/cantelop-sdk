import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CantelopClient } from "../dist/index.js";
import { createProtocolWorker } from "../dist/protocol-edge.js";
import { buildEdgeApi, buildSessionRuntime, buildBackendClient, buildAppArtifacts, watchLocalProject } from "../dist/build.js";
import { compileClientDefinition, compileAppDefinitions } from "../dist/compiler.js";
const clientModule = new URL("../dist/client.js", import.meta.url).pathname;
const messageId = "msg_" + "1".repeat(32);
function command(type = "view") { return { protocolVersion: 2, id: messageId, workspace: { slug: "customer" }, session: { id: "chat" }, command: { type } }; }
function request(body, runtimeId) { return new Request("https://agent.example/commands", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer scoped", ...(runtimeId === undefined ? {} : { "X-Cantelop-Session-Runtime": runtimeId }) }, body: JSON.stringify(body) }); }
function clientSource(body = 'receive() {}', imports = '') { return `import { CantelopClient } from ${JSON.stringify(clientModule)}; ${imports}
export const cantelop = new CantelopClient().app({ name: "first-agent", runtime: { ${body} } });`; }
async function project(t) { const directory = await mkdtemp(path.join(tmpdir(), "cantelop-inline-")); t.after(() => rm(directory, { recursive: true, force: true })); return { directory, definition: path.join(directory, "cantelop.mts"), outdir: path.join(directory, "out") }; }

test("Apps require handler implementations, reject developer identity, and freeze a snapshot", () => {
  for (const value of [undefined, null, {}, { receive: 42 }, { receive() {}, id: 'manual' }, { receive() {}, entrypoint: './agent.ts' }, { receive() {}, onActivate: 3 }]) assert.throws(() => new CantelopClient().app({ name: "first-agent",runtime: value}), TypeError);
  const receive = () => {};
  const runtime = { receive };
  const client = new CantelopClient().app({ name: "first-agent",runtime: runtime});
  runtime.receive = () => { throw Error(); };
  assert.equal(client.runtime.receive, receive);
  assert.equal(Object.isFrozen(client.runtime), true);
});
test('Edge rejects missing or different runtime identity on every method before private routing', async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: "chat.v1", fetch: async () => { calls++; return Response.json({}); } });
  const commands = [
    { type: 'dispatch', message: 'hello' }, { type: 'steer', message: 'hello' },
    { type: 'request', message: 'hello', timeoutMs: 1000 }, { type: 'cancel', messageId },
    { type: 'status', messageId }, { type: 'stop' }, { type: 'view' }, { type: 'stream' },
    { type: 'workspace.resolve' }, { type: 'workspace.database' },
  ];
  for (const value of commands) {
    const body = { ...command(), session: value.type.startsWith('workspace.') ? null : { id: 'chat' }, command: value };
    for (const id of [undefined, 'other.v1']) {
      const response = await worker.fetch(request(body, id), { CANTELOP_INTEGRATION_TOKEN: 'scoped' });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'session_runtime_mismatch');
    }
  }
  assert.equal(calls, 0);
});



test("compiler splits imports and closures without executing runtime code; all artifacts share generated identity", async t => {
  const { directory, definition, outdir } = await project(t);
  await writeFile(path.join(directory, 'provider.ts'), 'throw new Error("provider-build-execution"); export const provider = "provider-runtime-only";');
  await writeFile(definition, clientSource('receive() { console.log(provider, prefix); }', 'import { provider } from "./provider.js"; const prefix = "captured-closure";').replace('runtime:', 'edgeUrl:"https://test.example", accessToken:"scoped", runtime:'));
  const compiled = await compileClientDefinition(definition);
  assert.match(compiled.definition.id, /^rt_[a-f0-9]{64}$/);
  assert.equal((await compileClientDefinition(definition)).definition.id, compiled.definition.id);
  assert.match(compiled.runtimeModule, /captured-closure/);
  assert.doesNotMatch(compiled.backendSource, /provider|captured-closure/);
  const native = await buildSessionRuntime({definition, outdir});
  const edge = await buildEdgeApi({definition, outdir: path.join(directory, 'edge')});
  const backend = await buildBackendClient({definition, outdir: path.join(directory, 'backend')});
  assert.equal(native.manifest.session_runtime_id, edge.manifest.session_runtime_id);
  assert.equal(backend.manifest.apps[0].session_runtime_id, edge.manifest.session_runtime_id);
  assert.doesNotMatch(await readFile(native.mainModule, 'utf8'), /CantelopClient|edge.cantelop.internal/);
  assert.doesNotMatch(await readFile(backend.mainModule, 'utf8'), /provider-runtime-only|provider-build-execution|captured-closure/);
  const evaluated = await import('data:text/javascript,' + encodeURIComponent(compiled.backendSource.replace(JSON.stringify(clientModule), JSON.stringify(new URL('../dist/client.js', import.meta.url).href))));
  const client = evaluated.cantelop;
  assert.equal('id' in client.runtime, false);
  const fetch = globalThis.fetch;
  let header;
  globalThis.fetch = async request => { header = request.headers.get('X-Cantelop-Session-Runtime'); return Response.json({}); };
  try { await client.workspace({slug:'customer'}).session().stop(); }
  finally { globalThis.fetch = fetch; }
  assert.equal(header, compiled.definition.id);
  await writeFile(path.join(directory, 'provider.ts'), 'export const provider = "changed-provider";');
  assert.notEqual((await compileClientDefinition(definition)).definition.id, compiled.definition.id);
});

test("compiler enforces contextual payload, output, lifecycle and reply contracts", async t => {
  const {definition, outdir} = await project(t);
  const prefix = `import { CantelopClient } from ${JSON.stringify(clientModule)}; export default new CantelopClient().app<{prompt:string},{text:string},{answer:string}>({ name: "first-agent",runtime:`;
  for (const runtime of ['{}', '{receive:42}', '{receive() {}, onActivate:3}', '{receive(ctx) {ctx.output.send({wrong:true});}}', '{receive(ctx) {ctx.reply({wrong:true});}}', '{receive(ctx) {ctx.message.payload.wrong;}}', '{receive(ctx: {message:{payload:{other:number}}}) {}}']) {
    await writeFile(definition, prefix + runtime + '});');
    await assert.rejects(buildEdgeApi({definition, outdir}), /Invalid Session runtime/);
  }
  await writeFile(definition, prefix + '{receive(ctx) {ctx.output.send({text:ctx.message.payload.prompt}); ctx.reply({answer:"ok"});}, onActivate() {}, onRecover() {}, redelivery:true}});');
  await buildSessionRuntime({definition,outdir});
});

test("compiler rejects dynamic definitions and runtime capture of the client", async t => {
  const {definition} = await project(t);
  for (const source of [clientSource('receive() { cantelop.workspace({slug:"self"}); }'), clientSource('receive() {}', 'console.log("ambiguous-effect");'), `import { CantelopClient } from ${JSON.stringify(clientModule)}; const opts={name:"first-agent",runtime:{receive(){}}}; export default new CantelopClient().app(opts);`]) {
    await writeFile(definition, source);
    await assert.rejects(compileClientDefinition(definition), /cannot capture|side effects|static object/);
  }
});

test("watch follows imported runtime and type contracts and recovers after invalid edits", {timeout:30000}, async t => {
  const {directory,definition,outdir} = await project(t);
  const contract = path.join(directory,'payload.ts');
  const agent = path.join(directory,'agent.ts');
  await writeFile(contract,'export type Payload = {prompt:string};');
  await writeFile(agent,`import type { Payload } from "./payload.js"; import type { SessionContext } from ${JSON.stringify(new URL('../dist/session.js',import.meta.url).pathname)}; export function receive(ctx:SessionContext<Payload>) {console.log("first-runtime",ctx.message.payload.prompt);}`);
  await writeFile(definition,`import {CantelopClient} from ${JSON.stringify(clientModule)}; import {receive} from "./agent.js"; import type {Payload} from "./payload.js"; export default new CantelopClient().app<Payload>({ name: "first-agent",runtime:{receive}});`);
  const events=[];
  const watcher=await watchLocalProject({sessionDefinition:definition,sessionRuntimeOutdir:outdir,onBuild:event=>events.push(event)});
  t.after(()=>watcher.dispose());
  const manifest=()=>readFile(path.join(outdir,'cantelop-runtime.json'),'utf8').then(JSON.parse);
  const initial=(await manifest()).session_runtime_id;
  await writeFile(agent,(await readFile(agent,'utf8')).replace('first-runtime','second-runtime'));
  await waitFor(()=>events.length>0);
  assert.equal(events.at(-1).error,undefined);
  const second=(await manifest()).session_runtime_id;
  assert.notEqual(second,initial);
  events.length=0;
  await writeFile(contract,'export type Payload = {other:number};');
  await waitFor(()=>events.some(e=>e.error));
  assert.equal((await manifest()).session_runtime_id,second);
  events.length=0;
  await writeFile(contract,'export type Payload = {prompt:string};');
  await waitFor(()=>events.length>0);
  assert.equal(events.at(-1).error,undefined);
});
async function waitFor(predicate) { const deadline=Date.now()+15000; while(!predicate()){if(Date.now()>deadline)throw Error('Timed out waiting for rebuild');await new Promise(resolve=>setTimeout(resolve,50));} }


test("discovery accepts any App export name, preserves aliases, and deduplicates the same instance", async t => {
  const {definition} = await project(t);
  const prelude = `import { CantelopClient as Client } from ${JSON.stringify(clientModule)};`;
  for (const [source, names] of [
    ['export const agent = new Client().app({name:"first-agent",runtime:{receive(){}}});', ['agent']],
    ['const agent = new Client().app({name:"first-agent",runtime:{receive(){}}}); export {agent as integration};', ['integration']],
    ['export const agent = new Client().app({name:"first-agent",runtime:{receive(){}}}); export {agent as integration}; export default agent;', ['agent','integration','default']],
    ['export const agent = new Client().app({name:"first-agent",runtime:{receive(){}}}); const alias = agent; export const integration = alias;', ['agent','integration']],
  ]) {
    await writeFile(definition, prelude + source);
    const compiled = await compileClientDefinition(definition);
    const module = await import('data:text/javascript,' + encodeURIComponent(compiled.backendSource.replace(JSON.stringify(clientModule), JSON.stringify(new URL('../dist/client.js',import.meta.url).href))));
    assert.deepEqual(Object.keys(module).sort(), names.sort());
    assert.ok(names.every(name => module[name] === module[names[0]]));
    assert.doesNotMatch(compiled.runtimeModule,/CantelopClient/);
  }
});

test("discovery rejects missing Apps and duplicate App names", async t => {
  const {definition} = await project(t);
  const prelude = `import {CantelopClient} from ${JSON.stringify(clientModule)};`;
  await writeFile(definition, prelude + 'const privateClient = new CantelopClient().app({ name: "first-agent",runtime:{receive(){}}}); export type Message=string;');
  await assert.rejects(compileClientDefinition(definition), /Export at least one App/);
  await writeFile(definition, prelude + 'export const first = new CantelopClient().app({ name: "first-agent",runtime:{receive(){}}}); export const second = new CantelopClient().app({ name: "first-agent",runtime:{receive(){}}});');
  await assert.rejects(compileClientDefinition(definition), /Duplicate App name/);
});


test("multiple named Apps build isolated runtimes and matching deployment identities", async t => {
  const {directory,definition,outdir}=await project(t);
  await writeFile(path.join(directory,'support.ts'),'throw new Error("support provider executed during build"); export function receive(){console.log("support-only-runtime");}');
  await writeFile(path.join(directory,'research.ts'),'throw new Error("research provider executed during build"); export function receive(){console.log("research-only-runtime");}');
  await writeFile(definition,`import {CantelopClient} from ${JSON.stringify(clientModule)};
    import {receive as receiveSupport} from "./support.js";
    import {receive as receiveResearch} from "./research.js";
    const cantelop=new CantelopClient();
    export const support=cantelop.app({name:"support-agent",runtime:{receive:receiveSupport},environment:{SUPPORT_KEY:{secret:true,required:true}}});
    export const research=cantelop.app({name:"research-agent",runtime:{receive:receiveResearch},dockerfile:"docker/Dockerfile"});`);
  const compiled=await compileAppDefinitions(definition);
  assert.deepEqual(compiled.apps.map(app=>app.definition.name),['support-agent','research-agent']);
  assert.doesNotMatch(compiled.backendSource,/receiveSupport|receiveResearch|support.js|research.js/);
  assert.match(compiled.apps[0].runtimeModule,/support-only-runtime/);
  assert.doesNotMatch(compiled.apps[0].runtimeModule,/research-only-runtime/);
  assert.match(compiled.apps[1].runtimeModule,/research-only-runtime/);
  assert.doesNotMatch(compiled.apps[1].runtimeModule,/support-only-runtime/);
  await assert.rejects(buildEdgeApi({definition,outdir}),/Multiple Apps: select an App by name/);
  await assert.rejects(buildSessionRuntime({definition,outdir,app:'missing'}),/App not found/);
  const artifacts=await buildAppArtifacts({definition,outdir});
  assert.equal(artifacts.apps.length,2);
  for(const app of artifacts.apps){
    assert.equal(app.edge.manifest.app_name,app.name);
    assert.equal(app.runtime.manifest.app_name,app.name);
    assert.equal(app.edge.manifest.session_runtime_id,app.runtime.manifest.session_runtime_id);
    assert.equal(artifacts.backend.manifest.apps.find(record=>record.name===app.name).session_runtime_id,app.runtime.manifest.session_runtime_id);
    assert.match(app.runtime.mainModule,new RegExp(app.name));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(artifacts.apps[0].runtime.manifest.environment)),{SUPPORT_KEY:{secret:true,required:true}});
  assert.equal(artifacts.apps[1].runtime.manifest.dockerfile,'docker/Dockerfile');
});

test("App names and deployment configuration are statically validated", async t=>{
  const {definition}=await project(t);
  for(const options of ['name:process.env.APP_NAME', 'name:"BAD"', 'name:"first-agent",environment:{CANTELOP_TOKEN:{secret:true}}', 'name:"first-agent",environment:{TOKEN:{secret:true,default:"unsafe"}}', 'name:"first-agent",dockerfile:"../Dockerfile"']){
    await writeFile(definition,`import {CantelopClient} from ${JSON.stringify(clientModule)};export const app=new CantelopClient().app({${options},runtime:{receive(){}}});`);
    await assert.rejects(compileAppDefinitions(definition),/App name|Invalid App environment|project-relative|Invalid Session runtime/);
  }
});


test("App discovery rejects unrelated classes with matching SDK class and file names", async t=>{
  const {directory,definition}=await project(t);
  await writeFile(path.join(directory,'app.ts'),'export class App {workspace() {}}');
  await writeFile(path.join(directory,'client.ts'),'import {App} from "./app.js"; export class CantelopClient {app(_options:unknown){return new App();}}');
  await writeFile(definition,'import {CantelopClient} from "./client.js"; export const app=new CantelopClient().app({name:"fake",runtime:{receive(){}}});');
  await assert.rejects(compileAppDefinitions(definition),/Export at least one App/);
});


test("editing one inline App preserves sibling identity while nested contract edits invalidate its App", async t=>{
  const {directory,definition}=await project(t);
  await writeFile(path.join(directory,'contract.ts'),'export type Nested={value:string}; export type Payload={nested:Nested};');
  const source=`import {CantelopClient} from ${JSON.stringify(clientModule)}; import type {Payload} from "./contract.js";
    const cantelop=new CantelopClient();
    export const support=cantelop.app<Payload>({name:"support-agent",runtime:{receive(){console.log("support-one");}}});
    export const research=cantelop.app({name:"research-agent",runtime:{receive(){console.log("research-only");}}});`;
  await writeFile(definition,source);
  const first=await compileAppDefinitions(definition);
  await writeFile(definition,source.replace('support-one','support-two'));
  const second=await compileAppDefinitions(definition);
  assert.notEqual(second.apps[0].definition.id,first.apps[0].definition.id);
  assert.equal(second.apps[1].definition.id,first.apps[1].definition.id);
  await writeFile(path.join(directory,'contract.ts'),'export type Nested={value:number}; export type Payload={nested:Nested};');
  const third=await compileAppDefinitions(definition);
  assert.notEqual(third.apps[0].definition.id,second.apps[0].definition.id);
  assert.equal(third.apps[1].definition.id,second.apps[1].definition.id);
});
