import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApp, RemoteAppError, CANTELOP_INTEGRATION_PROTOCOL_VERSION } from "../dist/index.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/integration-v1.json", import.meta.url), "utf8"));
function session(fetch, workspace = fixtures.workspace) {
  return createApp({ connection: { fetch } }).workspace(workspace).session({ id: fixtures.session_id, keepAliveSeconds: 0 });
}

test("versioned controls stay outside application messages and do not provision Workspace", async () => {
  assert.equal(CANTELOP_INTEGRATION_PROTOCOL_VERSION, fixtures.protocol_version);
  const requests = [];
  const ref = session(async request => {
    requests.push(request.clone());
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/__cantelop/integration/v1/sessions/primary/controls");
    assert.equal(new URL(request.url).searchParams.get("workspace_slug"), "customer");
    return Response.json(fixtures.accepted, { status: 202 });
  });
  const receipt = await ref.steer(fixtures.steer.input, { id: fixtures.control_id });
  assert.deepEqual(await requests[0].json(), fixtures.steer);
  assert.equal(receipt.id, fixtures.control_id);
  assert.equal(receipt.state, "accepted");
  await ref.abort({ id: fixtures.control_id });
  assert.deepEqual(await requests[1].json(), fixtures.abort);
  assert.equal(requests.length, 2);
});

test("control status reports intake handling without claiming agent completion", async () => {
  const ref = session(async request => {
    if (request.method === "POST") return Response.json(fixtures.accepted);
    assert.equal(new URL(request.url).pathname, `/__cantelop/integration/v1/sessions/primary/controls/${fixtures.control_id}`);
    return Response.json(fixtures.handled);
  });
  const receipt = await ref.abort({ id: fixtures.control_id });
  assert.equal((await receipt.status()).state, "handled");
});

test("ambiguous controls expose a stable generated identity and are never automatically retried", async () => {
  let calls = 0;
  const failure = new Error("connection lost");
  const ref = session(async () => { calls++; throw failure; });
  await assert.rejects(ref.abort(), error => error instanceof RemoteAppError && error.code === "control_outcome_unknown" && /^msg_[0-9a-f]{32}$/.test(error.messageId) && error.cause === failure);
  assert.equal(calls, 1);
});

test("capability and identity errors retain code, status and retry identity", async () => {
  for (const code of ["capability_unsupported", "workspace_conflict", "session_idle", "integration_protocol_unsupported"]) {
    await assert.rejects(session(async () => Response.json({ error: { code } }, { status: 409 })).steer("hi", { id: fixtures.control_id }),
      error => error.code === code && error.status === 409 && error.messageId === fixtures.control_id);
  }
});

test("view of an unmaterialized slug performs one non-provisioning request", async () => {
  let calls = 0;
  const ref = session(async request => {
    calls++;
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).pathname, "/__cantelop/integration/v1/sessions/primary");
    assert.equal(new URL(request.url).searchParams.get("workspace_slug"), "customer");
    return Response.json(fixtures.unmaterialized);
  });
  const snapshot = await ref.view();
  assert.equal(snapshot.state, "unmaterialized");
  assert.equal(snapshot.workspaceId, undefined);
  assert.deepEqual(snapshot.capabilities, { steer: true, abort: true });
  assert.deepEqual(snapshot.observedAt, new Date(fixtures.unmaterialized.observed_at));
  assert.equal(calls, 1);
});

test("canonical view validates Workspace binding; invalid snapshots fail closed", async () => {
  const ref = session(async () => Response.json(fixtures.active), { id: fixtures.workspace_id });
  assert.equal((await ref.view()).workspaceId, fixtures.workspace_id);
  for (const value of [
    { ...fixtures.active, protocol_version: 2 },
    { ...fixtures.active, id: "other" },
    { ...fixtures.active, observed_at: "bad" },
    { ...fixtures.active, state: "done" },
    { ...fixtures.active, workspace_id: undefined },
    { ...fixtures.active, workspace_id: "wsp_" + "f".repeat(32) },
    { ...fixtures.active, capabilities: { steer: "true", abort: true } },
  ]) await assert.rejects(session(async () => Response.json(value), { id: fixtures.workspace_id }).view(), RemoteAppError);
});

test("integration stop carries ID or slug binding without provisioning", async () => {
  for (const workspace of [fixtures.workspace, { id: fixtures.workspace_id }]) {
    const ref = session(async request => {
      const url = new URL(request.url);
      assert.equal(request.method, "DELETE");
      assert.equal(url.pathname, "/__cantelop/integration/v1/sessions/primary");
      assert.equal(url.searchParams.get(workspace.id ? "workspace_id" : "workspace_slug"), workspace.id ?? workspace.slug);
      return new Response(null, { status: 204 });
    }, workspace);
    await ref.stop();
  }
});

test("invalid control IDs, undefined steering and pre-aborted calls never reach transport", async () => {
  const ref = session(() => { throw new Error("unexpected fetch"); });
  await assert.rejects(ref.abort({ id: "bad" }), TypeError);
  await assert.rejects(ref.steer(undefined), TypeError);
  const signal = AbortSignal.abort();
  await assert.rejects(ref.abort({ signal }), { name: "AbortError" });
  await assert.rejects(ref.view({ signal }), { name: "AbortError" });
});

test("malformed control acceptance preserves identity for recovery", async () => {
  for (const value of [{ ...fixtures.accepted, id: "other" }, { ...fixtures.accepted, accepted_at: "bad" }, { ...fixtures.accepted, protocol_version: 2 }]) {
    await assert.rejects(session(async () => Response.json(value)).abort({ id: fixtures.control_id }), error => error.code === "invalid_control_response" && error.messageId === fixtures.control_id);
  }
});
