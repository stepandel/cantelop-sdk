#!/usr/bin/env node
// Protocol double for SDK unit tests only. Native confinement and OS locking are
// qualified against the Go CLI by setting CANTELOP_SYNC_HELPER in the test run.
import { createServer } from 'node:http';
import { open, mkdir, readFile, writeFile, unlink, rename, lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validSyncPath } from '../../dist/sync.js';

const args=process.argv.slice(2),root=await realpath(args[args.indexOf('--directory')+1]),workspace=args[args.indexOf('--workspace')+1];
const stateDirectory=path.join(args[args.indexOf('--state-directory')+1],createHash('sha256').update(root).digest('hex'));await mkdir(stateDirectory,{recursive:true,mode:0o700});
const lock=path.join(stateDirectory,'lock');let owned=false;
try{await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});owned=true;}catch{process.stderr.write('sync_locked\n');process.exit(1);}
const token=randomBytes(32).toString('hex'),state=path.join(stateDirectory,`${workspace}.json`);
const version=(data,executable)=>createHash('sha256').update(Buffer.from([executable?1:0])).update(data).digest('hex');
const file=async name=>{
  if(!validSyncPath(name))throw new Error('sync_invalid_path');
  const parts=name.split('/');let current=root;
  for(const part of parts){current=path.join(current,part);try{const info=await lstat(current);if(info.isSymbolicLink())throw new Error('sync_unsupported_file');}catch(e){if(e.code!=='ENOENT')throw e;}}
  try{const info=await lstat(current);if(!info.isFile()||info.nlink!==1)throw new Error('sync_unsupported_file');const data=await readFile(current),executable=Boolean(info.mode&0o111);return {data,path:name,version:version(data,executable),executable,size:data.length};}catch(e){if(e.code==='ENOENT')return null;throw e;}
};
const body=async request=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);return Buffer.concat(chunks);};
const server=createServer(async(request,response)=>{
  const fail=(code,status=409)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{code}}));};
  try{
    if(request.headers.authorization!==`Bearer ${token}`){fail('unauthorized',401);return;}
    const url=new URL(request.url,'http://local');
    if(url.pathname==='/state'){
      if(request.method==='GET'){try{response.end(await readFile(state));}catch(e){if(e.code==='ENOENT'){response.writeHead(204);response.end();}else throw e;}}
      else{await writeFile(state,await body(request),{mode:0o600});response.writeHead(204);response.end();}return;
    }
    const op=url.searchParams.get('op'),name=url.searchParams.get('path'),base=url.searchParams.get('base');
    if(op==='scan'){
      const entries=[];const scan=async prefix=>{for(const child of await readdir(path.join(root,prefix),{withFileTypes:true})){const name=prefix+child.name;if(!validSyncPath(name))continue;if(child.isDirectory())await scan(name+'/');else if(child.isFile()){const {data,...entry}=await file(name);entries.push(entry);}}};
      await scan('');response.end(JSON.stringify({protocolVersion:1,root:'project',writes:true,entries}));return;
    }
    const previous=await file(name);if((previous?.version??'missing')!==base){fail('sync_conflict');return;}
    if(op==='read'){response.end(previous.data);return;}
    if(op==='remove'){await unlink(path.join(root,name));response.writeHead(204);response.end();return;}
    const data=await body(request),executable=url.searchParams.get('executable')==='1',temporary=path.join(root,'.cantelop-sync-'+randomUUID());
    await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(temporary,data,{mode:executable?0o755:0o644});await rename(temporary,path.join(root,name));response.end(JSON.stringify({path:name,version:version(data,executable),size:data.length,executable}));
  }catch(error){fail(error.message);}
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({protocolVersion:1,origin:`http://127.0.0.1:${server.address().port}`,directory:root,token})+'\n'));
process.stdin.resume();process.stdin.on('end',()=>server.close(async()=>{if(owned)await unlink(lock).catch(()=>{});}));
