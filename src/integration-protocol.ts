import type { AppCommandEnvelope, AppEnvironmentEnvelope, WorkspaceSelector } from "./integration.js";
import { ENVIRONMENT_COMMAND_TYPES, validateEnvironmentCommand, type EnvironmentCommand } from "./environment-command.js";
import { isAuthCommand } from "./runtime-command.js";
import { AUTH_SESSION_ID } from "./native-auth.js";

export const CANTELOP_INTEGRATION_PROTOCOL_VERSION = 2;
/** Each command has its own path so every layer between backend and Edge can see the operation. */
export const APP_COMMAND_PATH_PREFIX = "/commands/";
export const WORKSPACE_COMMAND_TYPES = Object.freeze(["workspace.resolve", "workspace.database", "workspace.inspect", "workspace.delete"] as const);
export type WorkspaceCommandType = (typeof WORKSPACE_COMMAND_TYPES)[number];
export const APP_COMMAND_TYPES = Object.freeze([
  ...ENVIRONMENT_COMMAND_TYPES,
  ...WORKSPACE_COMMAND_TYPES,
  "dispatch", "steer", "request", "auth", "cancel", "status", "view", "stop", "stream",
] as const);
export type AppCommandType = (typeof APP_COMMAND_TYPES)[number];
export const appCommandPath = (type: AppCommandType) => `${APP_COMMAND_PATH_PREFIX}${type}`;
/** The command type a path addresses, or undefined for any other path. */
export function appCommandType(pathname: string): AppCommandType | undefined {
  if (!pathname.startsWith(APP_COMMAND_PATH_PREFIX)) return undefined;
  const type = pathname.slice(APP_COMMAND_PATH_PREFIX.length);
  return (APP_COMMAND_TYPES as readonly string[]).includes(type) ? type as AppCommandType : undefined;
}
export const MAX_COMMAND_BYTES = 1024 * 1024;
/** Shared by App names and App-scoped Workspace slugs. */
export const SLUG_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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
  if (typeof value.slug !== "string" || !SLUG_PATTERN.test(value.slug)) throw new TypeError("Invalid Cantelop Workspace slug");
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
export type ProtocolEnvelope = AppCommandEnvelope | AppEnvironmentEnvelope;
/** Validate untrusted Edge input before any private routing or provisioning. */
export function validateCommand(value: unknown): ProtocolEnvelope {
  if (!record(value) || value.protocolVersion !== 2 || Object.keys(value).some(key => !["protocolVersion", "id", "workspace", "session", "command"].includes(key))) throw new TypeError("Invalid command envelope");
  assertMessageID(value.id);
  if (record(value.command) && (ENVIRONMENT_COMMAND_TYPES as readonly unknown[]).includes(value.command.type)) {
    if (value.workspace !== null || value.session !== null) throw new TypeError("App environment commands require null Workspace and Session");
    const keys = value.command.type === "app.environment.set" ? ["type", "name", "value", "secret"] : value.command.type === "app.environment.unset" ? ["type", "name", "secret"] : ["type", "revision"];
    if (Object.keys(value.command).length !== keys.length || Object.keys(value.command).some(key => !keys.includes(key))) throw new TypeError("Invalid environment command fields");
    validateEnvironmentCommand(value.command as unknown as EnvironmentCommand);
    return value as unknown as AppEnvironmentEnvelope;
  }
  const workspace = workspaceSelector(value.workspace);
  if (Object.keys(value.workspace as object).length !== 1) throw new TypeError("Invalid Workspace selector");
  if (!record(value.command) || typeof value.command.type !== "string") throw new TypeError("Invalid command");
  const command = value.command;
  let keys: string[];
  if ((WORKSPACE_COMMAND_TYPES as readonly unknown[]).includes(command.type)) {
    if (value.session !== null) throw new TypeError("Workspace command requires a null Session");
    if (command.type === "workspace.delete" && workspace.id === undefined) throw new TypeError("Workspace deletion requires a canonical ID");
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
      case "auth":
        if (value.session.id !== AUTH_SESSION_ID) throw new TypeError("Auth requires the reserved Session");
        if (!isAuthCommand(command.auth)) throw new TypeError("Invalid auth command");
        if (!Number.isSafeInteger(command.timeoutMs) || (command.timeoutMs as number) < 1 || (command.timeoutMs as number) > 300000) throw new TypeError("Invalid timeoutMs");
        assertKeepAlive(command.keepAliveSeconds);
        keys = ["type", "auth", "timeoutMs", "keepAliveSeconds"];
        break;
      case "cancel": assertKeepAlive(command.keepAliveSeconds); keys=["type","keepAliveSeconds"]; break;
      case "status": assertMessageID(command.messageId); keys=["type","messageId"]; break;
      case "view": case "stop": keys = ["type"]; break;
      case "stream": if (command.after !== undefined) assertCursor(command.after); keys = ["type", "after"]; break;
      default: throw new TypeError("Unknown command");
    }
  }
  if (Object.keys(command).some(key => !keys.includes(key))) throw new TypeError("Invalid command fields");
  return { ...value, workspace } as AppCommandEnvelope;
}
/** Validate a relayed command as a whole: a bounded JSON POST to the path of the envelope's own command type. */
export function validateCommandRequest(method: string, url: URL, body: Uint8Array): ProtocolEnvelope {
  const type = appCommandType(url.pathname);
  if (method !== "POST" || type === undefined || url.search) throw new TypeError("Invalid command route");
  if (body.byteLength > MAX_COMMAND_BYTES) throw new TypeError("Command exceeds 1 MiB");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new TypeError("Invalid command JSON"); }
  const envelope = validateCommand(value);
  if (envelope.command.type !== type) throw new TypeError("Command type does not match its path");
  return envelope;
}
