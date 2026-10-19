import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClaudeRuntime } from '../../dist/harnesses/claude.js';
const [root,mode]=process.argv.slice(2);
let active=false,reply;
const lifetime=new AbortController(),observed=[];
const keepAlive=setInterval(()=>{},1000);
const factory=(context,options,emit)=>{
  let resolve;const done=new Promise(r=>{resolve=r;});
  const run={accepting:true,done,cancel(){run.accepting=false;resolve();},async send(id,text){
    await appendFile(root+'/effects','executed\n');
    await emit({type:'user',uuid:id,message:{role:'user',content:text}});
    if(mode==='stream'){
      await emit({type:'stream_event',event:{type:'message_start',message:{id:'partial'}}});
      await emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'CRASH_OBSERVATION_SENTINEL'}}});
    }else{
      run.accepting=false;await emit({type:'result',result:'Recovered safe delivery',is_error:false});resolve();
    }
  }};return run;
};
const behaviour=createClaudeRuntime({workspace:root},factory);
const output={send:async event=>{observed.push(event);}};
const view={commit:async value=>{
  if(mode==='stream'&&value.entries.some(e=>e.text.includes('CRASH_OBSERVATION_SENTINEL'))){
    process.send({type:'boundary',revision:value.revision});await new Promise(()=>{});
  }
}};
const activity={get active(){return active;},start(work){
  active=true;
  if(mode==='admit'){process.send({type:'boundary'});return;}
  const pending=[];
  void Promise.resolve().then(()=>work({signal:lifetime.signal,output,view,send:command=>pending.push(command)})).then(async()=>{
    active=false;
    for(const payload of pending)await behaviour.receive({...base,message:{id:randomUUID(),sequence:1,payload},reply:value=>{reply=value;}});
  }).catch(error=>{console.error(error);process.exit(1);});
},cancel(){return false;},extend(){}};
const base={signal:lifetime.signal,session:{id:'crash-session',workspaceSlug:'user',keepAliveSeconds:300},env:{},database:async()=>{throw Error('unused');},activity,output,view,send:async()=>{}};
await behaviour.onActivate(base);
if(mode==='recover'){
  while(active)await new Promise(r=>setTimeout(r,5));
  await behaviour.receive({...base,message:{id:randomUUID(),sequence:1,payload:{type:'snapshot'}},reply:value=>{reply=value;}});
  const effects=(await readFile(root+'/effects','utf8').catch(()=>''));
  process.send({type:'restored',state:reply.state,effects:effects.trim().split('\n').filter(Boolean).length,observed});
}else{
  await behaviour.receive({...base,message:{id:'original-command',sequence:1,payload:{type:'input',id:'one',text:'Possibly executed'}},reply:value=>{reply=value;}});
}
