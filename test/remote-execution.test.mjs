import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteExecutionError,
  createRemoteExecutionProvider,
} from "../dist/api.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const executionId = "exec_0123456789abcdef0123456789abcdef";

test("remote execution selects an explicit Workspace and uses the v1 runtime contract", async () => {
  let forwarded;
  const provider = createRemoteExecutionProvider({
    executionId: () => executionId,
    fetch: async (request) => {
      forwarded = request;
      return Response.json({ output: { answer: "done" } });
    },
  });

  const execution = await provider.forWorkspace(workspaceId).start({ prompt: "hello" });
  assert.deepEqual(await execution.wait(), { answer: "done" });
  assert.equal(execution.status, "succeeded");
  assert.equal(
    forwarded.url,
    `https://runtime.cantelop.internal/__cantelop/v1/executions/${executionId}`,
  );
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.redirect, "manual");
  assert.equal(forwarded.headers.get("X-Cantelop-Edge-Workspace-ID"), workspaceId);
  assert.deepEqual(await forwarded.json(), { input: { prompt: "hello" } });
});

test("remote execution requires a concrete Workspace ID", () => {
  const provider = createRemoteExecutionProvider();
  assert.throws(() => provider.forWorkspace("primary"), /Invalid Cantelop Workspace ID/);
});

test("remote execution exposes stable remote errors", async () => {
  const provider = createRemoteExecutionProvider({
    executionId: () => executionId,
    fetch: async () => Response.json(
      { error: { code: "workspace_unavailable", message: "private detail" } },
      { status: 409 },
    ),
  });
  const execution = await provider.forWorkspace(workspaceId).start({});

  await assert.rejects(execution.wait(), (error) => {
    assert.ok(error instanceof RemoteExecutionError);
    assert.equal(error.code, "workspace_unavailable");
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /private detail/);
    return true;
  });
  assert.equal(execution.status, "failed");
});

test("remote execution cancellation aborts the runtime request", async () => {
  let observedSignal;
  const provider = createRemoteExecutionProvider({
    executionId: () => executionId,
    fetch: (request) => {
      observedSignal = request.signal;
      return new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    },
  });
  const execution = await provider.forWorkspace(workspaceId).start({});
  await execution.cancel(new Error("cancelled by test"));

  await assert.rejects(execution.wait(), /cancelled by test/);
  assert.equal(observedSignal.aborted, true);
  assert.equal(execution.status, "cancelled");
});
