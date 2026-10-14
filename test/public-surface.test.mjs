import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime-only project schema requires a version", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/app-v3.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema_version.const, 3);
  assert.deepEqual(schema.required, ["schema_version", "definition"]);
  for (const example of schema.examples) assert.equal(example.schema_version, 3);
});
