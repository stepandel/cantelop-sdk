import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CantelopClient } from '../dist/index.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { buildAppArtifacts } from '../dist/build.js';
import { compileClientDefinition } from '../dist/compiler.js';

const request = (method = 'GET', path = '/') => new Request(`https://app.example${path}`, { method });
test('optional homepage serves only root GET/HEAD and shares the typed App request context', async () => {
  let invocations = 0;
  const worker = createProtocolWorker({runtimeId:'test.v1',appName:'home',environment:{SITE_SECRET:{secret:true,required:true}},homepage({app,request,env}) {
    invocations++;
    assert.equal(app.name,'home'); assert.equal(env.SITE_SECRET,'site-secret');
    const session = app.workspace({slug:'customer'}).session({id:'chat'});
    assert.equal(session.id,'chat');
    return new Response(`<h1>${app.name}</h1>`, {headers:{'Content-Type':'text/html','X-Query':new URL(request.url).searchParams.get('q') ?? ''}});
  }});
  const bindings = {SITE_SECRET:'site-secret',CANTELOP_INTEGRATION_TOKEN:'token'};
  const response = await worker.fetch(request('GET','/?q=hello'),bindings);
  assert.equal(response.status,200); assert.equal(response.headers.get('X-Query'),'hello'); assert.equal(await response.text(),'<h1>home</h1>');
  const head = await worker.fetch(request('HEAD'),bindings);
  assert.equal(head.status,200); assert.equal(head.headers.get('Content-Type'),'text/html'); assert.equal(await head.text(),'');
  const wrong = await worker.fetch(request('POST'),bindings);
  assert.equal(wrong.status,405); assert.equal(wrong.headers.get('Allow'),'GET, HEAD'); assert.equal(invocations,2);
  assert.equal((await worker.fetch(request('GET','/commands'),bindings)).status,401);
  assert.equal((await worker.fetch(request(),{})).status,503); assert.equal(invocations,2);
});

test('homepage remains optional and handler errors do not leak secrets', async () => {
  const plain = createProtocolWorker({runtimeId:'test.v1'});
  const authorized = new Request('https://app.example/',{headers:{Authorization:'Bearer token'}});
  assert.equal((await plain.fetch(authorized,{CANTELOP_INTEGRATION_TOKEN:'token'})).status,404);
  for (const homepage of [() => {throw Error('private-secret');}, () => 'invalid']) {
    const worker = createProtocolWorker({runtimeId:'test.v1',appName:'home',homepage});
    const response = await worker.fetch(request());
    assert.equal(response.status,500); assert.deepEqual(await response.json(),{error:{code:'homepage_failed'}});
  }
  assert.throws(() => new CantelopClient().app({name:'home',runtime:{receive(){}},homepage:'invalid'}),TypeError);
});

test('compiler extracts inline, imported, shorthand and method homepages without rotating Session identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'cantelop-homepage-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const definition = path.join(directory,'cantelop.mts');
  const clientModule = new URL('../dist/client.js',import.meta.url).pathname;
  const source = (property,imports='') => `import { CantelopClient } from ${JSON.stringify(clientModule)}; ${imports}
export const app = new CantelopClient().app<{prompt:string}>({name:"home",runtime:{receive(){console.log("sandbox-only-home");}},${property}});`;
  for (const property of ['homepage: ({app, request}) => new Response(app.name)', 'homepage({app}) { return new Response(app.name); }']) {
    await writeFile(definition,source(property)); await compileClientDefinition(definition);
  }
  const homeFile = path.join(directory,'home.ts');
  await writeFile(homeFile,'export function homepage() {return new Response("homepage-only-marker",{headers:{"Content-Type":"text/html"}});}');
  await writeFile(definition,source('homepage','import { homepage } from "./home.js";'));
  const initial = await compileClientDefinition(definition);
  const artifacts = await buildAppArtifacts({definition,outdir:path.join(directory,'out')});
  const edge = artifacts.apps[0].edge;
  assert.equal(edge.manifest.homepage,true);
  assert.match(await readFile(edge.mainModule,'utf8'),/homepage-only-marker/);
  assert.doesNotMatch(await readFile(edge.mainModule,'utf8'),/sandbox-only-home/);
  assert.doesNotMatch(await readFile(artifacts.apps[0].runtime.mainModule,'utf8'),/homepage-only-marker/);
  assert.doesNotMatch(await readFile(artifacts.backend.mainModule,'utf8'),/homepage-only-marker/);
  const worker = (await import(pathToFileURL(edge.mainModule))).default;
  assert.equal(await (await worker.fetch(request())).text(),'homepage-only-marker');
  await writeFile(homeFile,'export function homepage() {return new Response("changed-homepage");}');
  assert.equal((await compileClientDefinition(definition)).definition.id,initial.definition.id);
  await writeFile(definition,source('homepage({app}) { app.workspace({slug:"customer"}).session().dispatch(42); return new Response(); }'));
  await assert.rejects(compileClientDefinition(definition),/Invalid Session runtime/);
  await writeFile(definition,source('homepage() {app.workspace({slug:"customer"}); return new Response();}'));
  await assert.rejects(compileClientDefinition(definition),/cannot capture/);
});
