import assert from "node:assert/strict";
import test from "node:test";
import { CantelopClient } from "../dist/index.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const workspace = {
  id: workspaceId, app_id: "app_0123456789abcdef0123456789abcdef", slug: "customer",
  hostname: "customer--agent.app.cantelop.dev", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z",
};
test("Workspace database uses the canonical credential route and recreates a closed handle", async () => {
  for (const selector of [{ slug: "customer" }, { id: workspaceId }]) {
    let resolutions = 0;
    let credentials = 0;
    const ref = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { async fetch(request) {
      const envelope = await request.clone().json();
      if (envelope.command.type === "workspace.database") {
        credentials++;
        assert.deepEqual(envelope.workspace, { id: workspaceId });
        assert.equal(envelope.session, null);
        return Response.json({ url: "libsql://workspace-cantelop.turso.io", authToken: "test-only", expiresAt: new Date(Date.now() + 900000).toISOString() });
      }
      resolutions++;
      return Response.json(workspace);
    } } }).workspace(selector);
    const [first, same] = await Promise.all([ref.database(), ref.database()]);
    assert.equal(first, same);
    assert.equal(resolutions, 1);
    assert.equal(credentials, 1);
    first.close();
    const second = await ref.database();
    assert.notEqual(first, second);
    assert.equal(resolutions, 1);
    assert.equal(credentials, 2);
    second.close();
  }
});
