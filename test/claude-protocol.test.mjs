import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeSessionOutput, validateClaudeSessionConfig } from "../dist/harnesses/claude-protocol.js";
test("protocol config validation retains native restrictions and rejects invalid CLI/MCP settings",()=>{
  const settings={tools:[],allowedTools:["mcp__canvas__edit"],mcps:{canvas:{type:"http",url:"https://tools.example/mcp"}},model:"sonnet",systemPrompt:"Rules",maxTurns:24};
  assert.deepEqual(validateClaudeSessionConfig(settings),settings);
  assert.deepEqual(validateClaudeSessionConfig({}),{tools:[],allowedTools:[],mcps:{}});
  for(const config of [{tools:["--danger"]},{allowedTools:["Read,Write"]},{maxTurns:0},{systemPrompt:"x".repeat(32769)},{mcps:{canvas:{type:"http",url:"https://user:pass@example.com"}}},{extra:"ignored"}])
    assert.throws(()=>validateClaudeSessionConfig(config));
});
const fragment=(eventId,index,total,json,id="run")=>({type:"claude.fragment",id,eventId,index,total,json});
test("output decoder isolates message IDs and reconstructs out-of-order Unicode fragments",()=>{
  const output=new ClaudeSessionOutput("run");const native={type:"result",result:"Done 😀",subtype:"success",is_error:false};const json=JSON.stringify(native);
  assert.equal(output.accept({type:"claude",id:"other",event:native}),undefined);
  assert.equal(output.accept(fragment("event",1,2,json.slice(20))),undefined);
  assert.equal(output.accept(fragment("event",1,2,json.slice(20))),undefined);
  assert.deepEqual(output.accept(fragment("event",0,2,json.slice(0,20))),native);
  assert.throws(()=>output.accept(fragment("bad",0,100000,"")),/Invalid/);
  output.accept(fragment("conflict",0,2,"first"));
  assert.throws(()=>output.accept(fragment("conflict",0,2,"second")),/Conflicting/);
});
test("output decoder bounds UTF-8 bytes and outstanding groups before retaining fragments",()=>{
  const output=new ClaudeSessionOutput("run");
  assert.throws(()=>output.accept(fragment("large",0,2,"😀".repeat(1_100_000))),/limit/);
  for(let n=0;n<32;n++)output.accept(fragment(String(n),0,2,"x"));
  assert.throws(()=>output.accept(fragment("extra",0,2,"x")),/limit/);
});
