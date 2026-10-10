import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import * as sdk from "../dist/index.js";
import * as session from "../dist/session.js";
import * as build from "../dist/build.js";

test("the 1.0 public surface and compiled package remove Edge API authoring", async () => {
  assert.equal(typeof sdk.CantelopClient, "function");
  assert.equal("createApp" in sdk, false);
  assert.equal("defineSessionRuntime" in sdk, false);
  assert.equal("defineSessionBehaviour" in session, false);
  await assert.rejects(access(new URL("../dist/session-runtime-definition.js", import.meta.url)), { code: "ENOENT" });
  assert.equal("defineApi" in sdk, false);
  assert.equal("buildApi" in build, false);
  assert.equal("buildLocalApi" in build, false);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.version, "1.0.0-alpha.0");
  for (const name of ["api", "edge", "router"]) {
    assert.equal(`./${name}` in packageJson.exports, false);
    await assert.rejects(access(new URL(`../dist/${name}.js`, import.meta.url)), { code: "ENOENT" });
  }
  const declaration = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  assert.doesNotMatch(declaration, /\b(?:ApiContext|ApiDefinition|ApiFactory|Router|RouteHandler|SessionService|WorkspaceService|CantelopApp)\b/);
});

test("runtime-only project schema requires a version and rejects the removed API property", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/app-v3.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema_version.const, 3);
  assert.deepEqual(schema.required, ["schema_version", "definition"]);
  assert.equal("api" in schema.properties, false);
  for (const example of schema.examples) {
    assert.equal(example.schema_version, 3);
    assert.equal("api" in example, false);
  }
});
