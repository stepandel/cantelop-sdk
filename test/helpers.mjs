// Shared test helpers. Keep these generic; fixtures specific to one area stay in its test file.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Polls `predicate` until it returns truthy. The default timeout leaves headroom for loaded CI runners. */
export async function until(predicate, { timeoutMs = 5_000, intervalMs = 5, message = "condition not reached" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** Yields to every queued I/O callback and microtask once. */
export const nextTurn = () => new Promise(resolve => setImmediate(resolve));

export const deferred = () => Promise.withResolvers();

/** A fresh directory under the OS temp directory, removed after the test. */
export async function temporaryDirectory(t, prefix = "cantelop-test-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

export function close(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close(error => error ? reject(error) : resolve());
  });
}

export function origin(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}
