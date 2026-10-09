import type { AppCommandEnvelope, SessionCommand, WorkspaceSelector } from "./integration.js";

export const CANTELOP_INTEGRATION_PROTOCOL_VERSION = 2;
export const APP_COMMAND_PATH = "/__cantelop/app/v2/commands";
export const MAX_COMMAND_BYTES = 1024 * 1024;
export const messageID = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`;
export function assertMessageID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^msg_[0-9a-f]{32}$/.test(id)) throw new TypeError("Invalid Cantelop Message ID");
}
export function assertKeepAlive(value: unknown): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 604800)) {
    throw new TypeError("keepAliveSeconds must be an integer between 0 and 604800");
  }
}
export function workspaceSelector(value: unknown): WorkspaceSelector {
  if (!record(value) || (value.id === undefined) === (value.slug === undefined)) throw new TypeError("A Workspace requires exactly one ID or slug");
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || !/^wsp_[0-9a-f]{32}$/.test(value.id)) throw new TypeError("Invalid Cantelop Workspace ID");
    return Object.freeze({ id: value.id });
  }
  if (typeof value.slug !== "string" || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.slug)) throw new TypeError("Invalid Cantelop Workspace slug");
  return Object.freeze({ slug: value.slug });
}
export function assertSessionID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new TypeError("Invalid Cantelop Session ID");
}
export function assertCursor(value: unknown): void {
  if (!record(value) || typeof value.streamId !== "string" || !/^[0-9a-f]{32}$/.test(value.streamId) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || Object.keys(value).some(key => !["streamId", "sequence"].includes(key))) throw new TypeError("Invalid event cursor");
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validate untrusted Edge input before any private routing or provisioning. */
export function validateCommand(value: unknown): AppCommandEnvelope {
  if (!record(value) || value.protocolVersion !== 2 || Object.keys(value).some(key => !["protocolVersion", "id", "workspace", "session", "command"].includes(key))) throw new TypeError("Invalid command envelope");
  assertMessageID(value.id);
  const workspace = workspaceSelector(value.workspace);
  if (Object.keys(value.workspace as object).length !== 1) throw new TypeError("Invalid Workspace selector");
  if (!record(value.command) || typeof value.command.type !== "string") throw new TypeError("Invalid command");
  const command = value.command;
  let keys: string[];
  if (command.type === "workspace.resolve" || command.type === "workspace.database") {
    if (value.session !== null) throw new TypeError("Workspace command requires a null Session");
    keys = ["type"];
  } else {
    if (!record(value.session) || Object.keys(value.session).length !== 1) throw new TypeError("Invalid Session");
    assertSessionID(value.session.id);
    switch (command.type) {
      case "dispatch": case "steer": case "request":
        if (!("message" in command) || command.message === undefined) throw new TypeError("A message is required");
        assertKeepAlive(command.keepAliveSeconds);
        keys = ["type", "message", "keepAliveSeconds"];
        if (command.type === "request") {
          if (!Number.isSafeInteger(command.timeoutMs) || (command.timeoutMs as number) < 1 || (command.timeoutMs as number) > 300000) throw new TypeError("Invalid timeoutMs");
          keys.push("timeoutMs");
        }
        break;
      case "cancel": case "status": assertMessageID(command.messageId); keys = ["type", "messageId"]; break;
      case "view": case "stop": keys = ["type"]; break;
      case "stream": if (command.after !== undefined) assertCursor(command.after); keys = ["type", "after"]; break;
      default: throw new TypeError("Unknown command");
    }
  }
  if (Object.keys(command).some(key => !keys.includes(key))) throw new TypeError("Invalid command fields");
  return { ...value, workspace } as AppCommandEnvelope;
}
