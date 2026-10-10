import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CantelopClient, AppConfigurationError } from '../dist/index.js';
import { resolveAppConfiguration, parseAppConfiguration, APP_CONFIGURATION_CONTEXT_KEY } from '../dist/app-config.js';
import { loadNodeAppConfiguration } from '../dist/app-config-node.js';
const first = {id:'app_'+'1'.repeat(32),slug:'first-agent',accessToken:'first-token',runtimeId:'rt_first'};
const second = {id:'app_'+'2'.repeat(32),slug:'second-agent',accessToken:'second-token',runtimeId:'rt_second'};
const document = (apps=[first,second]) => ({schemaVersion:1,activeProfile:'default',profiles:{default:{apps:apps.map(app=>({...app}))}}});
const runtime = {receive(){}};

test('one pure client owns multiple Apps with isolated captured credentials and runtime identities', async () => {
  const key=Symbol.for(APP_CONFIGURATION_CONTEXT_KEY), previous=Reflect.get(globalThis,key), fetch=globalThis.fetch;
  const injected=document(); Reflect.set(globalThis,key,injected);
  const calls=[]; globalThis.fetch=async request=>{calls.push(request);return Response.json({});};
  try {
    const cantelop=new CantelopClient();
    const support=cantelop.app({name:first.slug,runtime});
    const research=cantelop.app({name:second.slug,runtime});
    assert.equal(calls.length,0);
    injected.profiles.default.apps[0].accessToken='changed';
    await support.workspace({slug:'tenant'}).session().stop();
    await research.workspace({slug:'tenant'}).session().stop();
    assert.deepEqual(calls.map(r=>[r.url,r.headers.get('Authorization'),r.headers.get('X-Cantelop-Session-Runtime')]),[
      ['https://first-agent.cantelop.dev/commands','Bearer first-token','rt_first'],
      ['https://second-agent.cantelop.dev/commands','Bearer second-token','rt_second'],
    ]);
    assert.throws(()=>cantelop.app({name:first.slug,runtime}),/Duplicate App name/);
    assert.equal(typeof cantelop.workspace,'undefined');
  } finally {globalThis.fetch=fetch;if(previous===undefined)Reflect.deleteProperty(globalThis,key);else Reflect.set(globalThis,key,previous);}
});

test('environment credentials cannot be borrowed by a differently named App', async () => {
  const env={CANTELOP_APP_SLUG:first.slug,CANTELOP_INTEGRATION_TOKEN:first.accessToken,CANTELOP_SESSION_RUNTIME_ID:first.runtimeId};
  const context={env,loadLocal:async()=>({})};
  assert.deepEqual(await resolveAppConfiguration({slug:first.slug},context),{edgeUrl:'https://first-agent.cantelop.dev',accessToken:'first-token',runtimeId:'rt_first'});
  await assert.rejects(resolveAppConfiguration({slug:second.slug},context),e=>e.code==='app_not_configured');
});

test('client profile selects credentials while compiled App identity takes precedence', async () => {
  const key=Symbol.for(APP_CONFIGURATION_CONTEXT_KEY),previous=Reflect.get(globalThis,key),fetch=globalThis.fetch;
  Reflect.set(globalThis,key,{schemaVersion:1,activeProfile:'default',profiles:{default:{apps:[first]},production:{apps:[{...first,accessToken:'production-token'}]}}});
  let request;globalThis.fetch=async r=>{request=r;return Response.json({});};
  try {
    const app=new CantelopClient({profile:'production'}).app({name:first.slug,runtime:{receive(){},[Symbol.for('dev.cantelop.sdk.compiled-runtime.v1')]:'rt_compiled'}});
    await app.workspace({slug:'tenant'}).session().stop();
    assert.equal(request.headers.get('Authorization'),'Bearer production-token');
    assert.equal(request.headers.get('X-Cantelop-Session-Runtime'),'rt_compiled');
  } finally {globalThis.fetch=fetch;if(previous===undefined)Reflect.deleteProperty(globalThis,key);else Reflect.set(globalThis,key,previous);}
});

test('invalid client/App options and invalid or expired credentials fail without leaking secrets', async () => {
  for(const options of [null,{runtime},{name:'app'},{profile:''},{profile:4}])assert.throws(()=>new CantelopClient(options),TypeError);
  for(const options of [{name:'BAD',runtime},{name:'first-agent'},{name:'first-agent',runtime,slug:'second-agent'},{name:'first-agent',runtime,edgeUrl:'https://example.test'}])assert.throws(()=>new CantelopClient().app(options),TypeError);
  assert.throws(()=>parseAppConfiguration(document([{...first,runtimeId:'bad runtime'}])),AppConfigurationError);
  await assert.rejects(resolveAppConfiguration({slug:first.slug},{env:{},injected:parseAppConfiguration(document([{...first,expiresAt:'2000-01-01'}]))}),e=>e.code==='app_credentials_expired'&&!e.message.includes(first.accessToken));
});

test('private integration profiles supply named App credentials independently of project manifests and CLI login', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'cantelop-app-profiles-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'integration.json');
  await writeFile(filename,JSON.stringify(document()),{mode:0o600});
  await writeFile(path.join(directory,'cantelop.json'),JSON.stringify({schema_version:3,definition:'src/cantelop.ts'}));
  const local=await loadNodeAppConfiguration({CANTELOP_INTEGRATION_CONFIG:filename},{directory});
  const config=await resolveAppConfiguration({slug:second.slug},{env:{},loadLocal:async()=>local});
  assert.equal(config.accessToken,second.accessToken);
  await chmod(filename,0o644);
  await assert.rejects(loadNodeAppConfiguration({CANTELOP_INTEGRATION_CONFIG:filename}),AppConfigurationError);
});
