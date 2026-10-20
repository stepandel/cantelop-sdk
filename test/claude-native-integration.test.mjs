import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClaudeRuntime } from '../dist/harnesses/claude.js';
import { createSessionRuntimeHandler } from '../dist/runtime.js';
import { applyClaudeSessionChange } from '../dist/harnesses/claude-protocol.js';
import { close, listen, until } from './helpers.mjs';

// Explicit native qualification: no paid model calls or host credentials.
const nativeBinary=process.env.CANTELOP_TEST_CLAUDE_BINARY;
const qualified = predicate => until(predicate, { timeoutMs: 15_000, intervalMs: 10, message: 'qualification timed out' });

test('pinned Claude integrates native steering, durable views, stopped reads and exact resume through the actor protocol and simulated platform collector', {skip:!nativeBinary,timeout:45000}, async t=>{
  const root=await mkdtemp('/tmp/claude-native-integration-');t.after(()=>rm(root,{recursive:true,force:true}));
  const requests=[];
  const api=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    const value=raw?JSON.parse(raw):{};
    if(!req.url?.startsWith('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":10}');return;}
    requests.push(value);res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    emit('message_start',{message:{id:'msg_'+randomUUID().replaceAll('-',''),type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    if(requests.length===1){
      const input={command:`printf x > '${root}/tool-started'; sleep 1`,description:'Isolated steering qualification'};
      emit('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_native',name:'Bash',input:{}}});
      emit('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}});
      emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:10}});
    }else{
      emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
      emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'QUALIFIED_NATIVE_ANSWER'}});
      emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});
    }
    emit('message_stop',{});res.end();
  });
  await listen(api);t.after(()=>close(api));
  const binary=join(root,'claude-wrapper');
  // Test-owned wrapper supplies only a fake credential and this local endpoint.
  // Native runtime environment isolation itself remains exercised.
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  await writeFile(binary,`#!/bin/sh\nexport ANTHROPIC_API_KEY=local-qualification-only\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${api.address().port}\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nexec ${quote(nativeBinary)} "$@"\n`,{mode:0o755});
  const sandboxId='sbx-'+ 'a'.repeat(32),workspaceId='wsp_'+ 'b'.repeat(32),sessionId='native-qualification';
  let latest,logical,after=0,collecting=true,collectorFailure;
  const events=[];
  async function actor(){
    const runtime=createClaudeRuntime({workspace:root,binary,permissionMode:'dontAsk',settingSources:[],tools:['Bash'],allowedTools:['Bash'],mcps:{},model:'sonnet',maxTurns:4});
    const server=createServer(createSessionRuntimeHandler(runtime,{sandboxId}));await listen(server);
    const call=(path,init={})=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{...init,headers:{'X-Cantelop-Sandbox-ID':sandboxId,'Content-Type':'application/json',...init.headers}});
    const collect=(async()=>{while(collecting){
      const response=await call(`/__cantelop/v2/runtime/events?after=${after}&wait=0`);assert.equal(response.status,200);
      for(const record of (await response.json()).events){
        if(record.view){latest={state:record.view,cursor:record.cursor};}
        else {events.push(record.event);if(record.event?.type==='session.changed')logical=logical?applyClaudeSessionChange(logical,record.event):record.event.state;}
        after=record.cursor;
      }
      const ack=await call('/__cantelop/v2/runtime/events/ack',{method:'POST',body:JSON.stringify({through:after})});assert.equal(ack.status,200);
      await new Promise(r=>setTimeout(r,2));
    }})().catch(error=>{collectorFailure=error;});
    let commandSequence=0;
    async function send(payload,type='dispatch'){
      const id='msg_'+(++commandSequence).toString(16).padStart(32,'0');
      const admission=await call('/__cantelop/v2/messages',{method:'POST',body:JSON.stringify({session:{id:sessionId,workspace_id:workspaceId,keep_alive_seconds:300},message:{id,payload:{__cantelop_command:2,type,message:payload}},reply:true})});assert.equal(admission.status,202,await admission.text());
      await qualified(async()=>{if(collectorFailure)throw collectorFailure;return ['succeeded','failed'].includes((await(await call('/__cantelop/v2/messages/'+id)).json()).state);});
      const reply=await(await call('/__cantelop/v2/messages/'+id+'/reply')).json();assert.ok(reply.reply,JSON.stringify(reply));return reply.reply;
    }
    return {send,async stop(){await qualified(async()=>{if(collectorFailure)throw collectorFailure;return (await(await call('/__cantelop/v2/runtime')).json()).quiescent;});collecting=false;await collect;await close(server);if(collectorFailure)throw collectorFailure;}};
  }
  let current=await actor();
  try{
    const first=await current.send({type:'input',id:'first',text:'FIRST_NATIVE_INPUT'});assert.equal(first.type,'input.status');
    await qualified(async()=>{try{await readFile(join(root,'tool-started'));return true;}catch{return false;}});
    const steer=await current.send({type:'steer',id:'second',text:'SECOND_NATIVE_INPUT'},'steer');assert.equal(steer.runId,first.runId);
    await qualified(()=>latest?.state.run?.status==='completed');
    assert.ok(requests[1].messages.some(m=>JSON.stringify(m).includes('SECOND_NATIVE_INPUT')));
    assert.equal(latest.state.inputs.filter(i=>i.status==='completed').length,2);
    assert.deepEqual(logical,latest.state);
    const persisted=structuredClone(latest.state);
    await current.stop();current=undefined;
    // The platform can serve this already committed value while no actor runs.
    assert.deepEqual(latest.state,persisted);
    after=0;collecting=true;collectorFailure=undefined;current=await actor();
    const continued=await current.send({type:'input',id:'third',text:'CONTINUE_NATIVE_INPUT'});assert.equal(continued.type,'input.status');
    await qualified(()=>latest?.state.inputs.find(i=>i.id==='third')?.status==='completed'&&latest.state.run.status==='completed');
    assert.equal(latest.state.conversationId,persisted.conversationId);
    assert.ok(requests.at(-1).messages.some(m=>JSON.stringify(m).includes('QUALIFIED_NATIVE_ANSWER')));
    assert.deepEqual(logical,latest.state);
  }finally{if(current)await current.stop();}
});
