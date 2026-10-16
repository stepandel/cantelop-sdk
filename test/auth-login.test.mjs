import assert from "node:assert/strict";
import test from "node:test";
import { CantelopClient, RemoteAppError } from "../dist/index.js";
function fixture(reply) {
  const commands = [];
  const app = new CantelopClient().app({name:"auth-agent",runtime:{receive(){}},auth:{status:()=>false,logout(){},terminal(){throw new Error("Sandbox only");}},
    connection:{async fetch(request){
      const envelope=await request.json(); commands.push(envelope);
      assert.deepEqual(envelope.workspace,{slug:"customer"});assert.equal(envelope.session.id,"cantelop-native-auth");
      return Response.json({protocolVersion:2,id:envelope.id,reply:reply(envelope.command.auth)});
    }},
  });
  return {auth:app.workspace({slug:"customer"}).auth(),commands};
}
const attemptId="lgn_"+"1".repeat(32);
const login=()=>({type:"login",attemptId,url:"https://claude.ai/oauth",expiresAt:new Date(Date.now()+60_000).toISOString()});
test("structured login returns an existing sign-in or a link without exposing terminal capabilities",async()=>{
  const existing=fixture(()=>({type:"status",authenticated:true}));
  assert.deepEqual(await existing.auth.login(),{authenticated:true});
  const {auth,commands}=fixture(login);
  const result=await auth.login({force:true});
  assert.equal(result.authenticated,false);assert.equal(result.attemptId,attemptId);assert.ok(result.expiresAt instanceof Date);
  assert.equal("terminal" in result,false);assert.equal("ticket" in result,false);
  assert.deepEqual(commands[0].command.auth,{type:"login",force:true});
});
test("submitCode and cancelLogin are Workspace-scoped SDK commands with attempt validation",async()=>{
  const {auth,commands}=fixture(command=>command.type==="code"?{type:"status",authenticated:true}:{type:"cancelled",attemptId});
  assert.equal(await auth.submitCode({attemptId,code:"provider-code"}),true);
  await auth.cancelLogin({attemptId});
  assert.deepEqual(commands.map(c=>c.command.auth),[{type:"code",attemptId,code:"provider-code"},{type:"cancel",attemptId}]);
  for(const code of ["", "x".repeat(2049),"code\ncommand","code\r", "code\x1b"])
    await assert.rejects(auth.submitCode({attemptId,code}),TypeError);
  await assert.rejects(auth.cancelLogin({attemptId:"foreign"}),TypeError);
  assert.equal(commands.length,2);
});
test("structured auth failures preserve stable safe codes and reject malformed replies",async()=>{
  const rejected=fixture(()=>({type:"error",code:"code_rejected"}));
  await assert.rejects(rejected.auth.submitCode({attemptId,code:"wrong"}),e=>e instanceof RemoteAppError&&e.code==="code_rejected");
  for(const reply of [{...login(),attemptId:"foreign"},{...login(),url:"http://example.com"},{...login(),expiresAt:"invalid"},{type:"status",authenticated:false},{type:"error",code:"secret-diagnostic"}])
    await assert.rejects(fixture(()=>reply).auth.login(),RemoteAppError);
});
test("aborted login never sends a command; invalid force and code options stay local",async()=>{
  const {auth,commands}=fixture(login);const controller=new AbortController();controller.abort(new Error("stopped"));
  await assert.rejects(auth.login({signal:controller.signal}),/stopped/);
  await assert.rejects(auth.login({force:"yes"}),TypeError);assert.equal(commands.length,0);
});
test("device login carries its browser code and rejects malformed codes", async () => {
  const good = fixture(() => ({ ...login(), userCode: "ABCD-EFGH" }));
  assert.equal((await good.auth.login()).userCode, "ABCD-EFGH");
  for (const userCode of ["private\noutput", "x".repeat(40), 42])
    await assert.rejects(fixture(() => ({ ...login(), userCode })).auth.login(), RemoteAppError);
});
