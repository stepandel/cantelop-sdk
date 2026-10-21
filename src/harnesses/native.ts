/**
 * Building blocks for wrapping a stock agent CLI as a Session harness: one subprocess
 * per turn with process-group cleanup, a per-Session native conversation mapping,
 * serialized turns with steering, output fragmentation and Workspace-scoped native
 * sign-in through a PTY. The Codex and OpenCode examples are built from these.
 *
 * Node-only. Import it from Sandbox runtime code (`runtime.create`, `auth`), never
 * from backend clients or Edge code; the Cantelop compiler removes those paths there.
 */
export {
  CliHarness, ConversationStore, fragmentNativeEvent, nativeEnvironment, runJsonProcess, NATIVE_EVENT_MAX_BYTES,
  type NativeEnvironmentHook, type NativeEvent, type NativeFragmentEvent, type NativeOptions, type NativeTurn,
} from "./cli.js";
export { loginTerminal, nativeAuth, runAuthCommand } from "./login.js";
export { TurnQueue } from "./queue.js";
export { writeDurableJson } from "./durable-file.js";
