import assert from "node:assert/strict";
import test from "node:test";

import { classifyRuntimeLogSeverity } from "../dist/runtime-log-capture.js";

test("classifies structured SDK lifecycle stderr as informational", () => {
  assert.equal(classifyRuntimeLogSeverity(JSON.stringify({
    component: "cantelop.sdk",
    event: "message_lifecycle",
    message_id: "msg_0123456789abcdef0123456789abcdef",
    state: "handled",
  }), "error", "stderr"), "info");
  assert.equal(classifyRuntimeLogSeverity(JSON.stringify({
    component: "cantelop.sdk",
    event: "session_runtime_startup_stage",
    stage: "listener_ready",
  }), "error", "stderr"), "info");
});

test("preserves severity for user output and untrusted lookalikes", () => {
  assert.equal(classifyRuntimeLogSeverity("startup failed", "error", "stderr"), "error");
  assert.equal(classifyRuntimeLogSeverity(JSON.stringify({
    component: "customer",
    event: "message_lifecycle",
  }), "error", "stderr"), "error");
  assert.equal(classifyRuntimeLogSeverity(JSON.stringify({
    component: "cantelop.sdk",
    event: "message_lifecycle",
  }), "warn", "console"), "warn");
});
