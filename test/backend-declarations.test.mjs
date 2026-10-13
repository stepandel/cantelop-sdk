import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { buildBackendClient, buildAppArtifacts } from "../dist/build.js";

const sdk = fileURLToPath(new URL("../", import.meta.url));
async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "cantelop-declarations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "node_modules/@cantelop"), { recursive: true });
  await symlink(sdk, path.join(directory, "node_modules/@cantelop/sdk"), "dir");
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  return directory;
}
function check(filename) {
  const program = ts.createProgram([filename], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => path.dirname(filename), getCanonicalFileName: f => f, getNewLine: () => "\n" }));
}

test("backend declarations preserve local recursive contracts, aliases and all App type parameters after relocation", async t => {
  const directory = await project(t);
  const source = path.join(directory, "source");
  await mkdir(source);
  await writeFile(path.join(source, "nested.ts"), 'export interface Payload { prompt: string; children?: Payload[] }');
  await writeFile(path.join(source, "protocol.ts"), [
    'import type { Payload } from "./nested.js";',
    'export type Command = { type: "run"; payload: Payload };',
    'export type Event = { type: "output"; text: string };',
    'export type Reply = { count: number };',
    'export type View = { running: boolean };',
  ].join("\n"));
  await writeFile(path.join(source, "native.ts"), 'throw new Error("must not execute native code"); export function receive() {}');
  const definition = path.join(source, "cantelop.ts");
  await writeFile(definition, [
    'import { CantelopClient } from "@cantelop/sdk";',
    'import type { Command, Event, Reply, View } from "./protocol.js";',
    'import { receive } from "./native.js";',
    'export const agent = new CantelopClient().app<Command, Event, Reply, View>({ name: "typed-agent", runtime: { receive } });',
    'export { agent as alias };',
    'export default agent;',
    'export const other = new CantelopClient().app<number, string, boolean>({ name: "other-agent", runtime: { receive } });',
  ].join("\n"));
  const artifact = await buildBackendClient({ definition, outdir: path.join(directory, "built") });
  assert.equal(artifact.declarationFile, path.join(artifact.directory, "client.d.mts"));
  const declarations = await readFile(artifact.declarationFile, "utf8");
  assert.doesNotMatch(declarations, /native|source\/|runtime/);
  const deployed = path.join(directory, "deployed");
  await cp(artifact.directory, deployed, { recursive: true });
  await rm(source, { recursive: true });
  await rm(artifact.directory, { recursive: true });
  const consumer = path.join(directory, "consumer.mts");
  await writeFile(consumer, [
    'import defaultAgent, { agent, alias, other } from "./deployed/client.mjs";',
    'const session = (await agent.workspace({slug: "user"})).session({id: "chat"});',
    'const reply = await session.request({type: "run", payload: {prompt: "hello", children: [{prompt: "child"}]}});',
    'const count: number = reply.count;',
    'const view = await session.view();',
    'const running: boolean = view.state.running;',
    '// @ts-expect-error reply is not any',
    'const wrong: string = reply.count;',
    '// @ts-expect-error rejects invalid command',
    'await session.request({type: "invalid"});',
    'for await (const event of session.stream()) { const text: string = event.data.text; }',
    'const same: typeof agent = alias;',
    'const defaultSame: typeof agent = defaultAgent;',
    'const otherSession = (await other.workspace({slug: "user"})).session({id: "chat"});',
    'const result: boolean = await otherSession.request(123);',
    '// @ts-expect-error each App retains its own contract',
    'await otherSession.request("wrong");',
  ].join("\n"));
  check(consumer);
});

test("buildAppArtifacts also emits declarations for inferred App contracts", async t => {
  const directory = await project(t);
  const definition = path.join(directory, "cantelop.mts");
  await writeFile(definition, [
    'import { CantelopClient } from "@cantelop/sdk";',
    'import type { SessionContext } from "@cantelop/sdk/session";',
    'export const agent = new CantelopClient().app({name: "inferred-agent", runtime: {receive(context: SessionContext<{prompt: string}, {text: string}, {ok: boolean}>) { void context; }}});',
  ].join("\n"));
  const artifacts = await buildAppArtifacts({ definition, outdir: path.join(directory, "out") });
  assert.equal(artifacts.backend.declarationFile, path.join(directory, "out/backend/client.d.mts"));
  const consumer = path.join(directory, "consumer.mts");
  await writeFile(consumer, [
    'import { agent } from "./out/backend/client.mjs";',
    'const session = (await agent.workspace({slug: "user"})).session({id: "chat"});',
    'const reply = await session.request({prompt: "hello"});',
    'const ok: boolean = reply.ok;',
    '// @ts-expect-error inferred command remains typed',
    'await session.request(123);',
  ].join("\n"));
  check(consumer);
});


test("a single-App build name override stamps all artifacts without changing source or exports", async t => {
  const directory = await project(t);
  const definition = path.join(directory, "cantelop.mts");
  const source = 'import { CantelopClient } from "@cantelop/sdk"; export const agent = new CantelopClient().app({name: "original-agent", runtime: {receive() {}}});';
  await writeFile(definition, source);
  const original = await buildBackendClient({ definition, outdir: path.join(directory, "original") });
  const backend = await buildBackendClient({ definition, outdir: path.join(directory, "backend"), appName: "deployed-agent" });
  const artifacts = await buildAppArtifacts({ definition, outdir: path.join(directory, "artifacts"), appName: "deployed-agent" });
  const identity = backend.manifest.apps[0].session_runtime_id;
  assert.equal(backend.manifest.apps[0].name, "deployed-agent");
  assert.notEqual(identity, original.manifest.apps[0].session_runtime_id);
  assert.equal(artifacts.apps[0].name, "deployed-agent");
  assert.equal(artifacts.apps[0].edge.manifest.app_name, "deployed-agent");
  assert.equal(artifacts.apps[0].runtime.manifest.app_name, "deployed-agent");
  assert.equal(artifacts.apps[0].runtime.manifest.session_runtime_id, identity);
  assert.equal(artifacts.apps[0].edge.manifest.session_runtime_id, identity);
  assert.equal(artifacts.backend.manifest.apps[0].session_runtime_id, identity);
  const { agent } = await import(new URL(backend.mainModule, "file:///").href);
  assert.equal(agent.name, "deployed-agent");
  assert.equal(await readFile(definition, "utf8"), source);
  await assert.rejects(buildBackendClient({ definition, outdir: path.join(directory, "invalid"), appName: "bad/name" }), /appName/);
  await writeFile(definition, source + 'export const other = new CantelopClient().app({name: "other-agent", runtime: {receive() {}}});');
  await assert.rejects(buildBackendClient({ definition, outdir: path.join(directory, "ambiguous"), appName: "deployed-agent" }), /exactly one App/);
});
