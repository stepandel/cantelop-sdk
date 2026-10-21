import type { AppCommandEnvelope, AppEnvironmentEnvelope, WorkspaceSelector } from "./integration.js";
import { isRecord, MESSAGE_ID_PATTERN, WORKSPACE_ID_PATTERN } from "./shared.js";
import type { EnvironmentCommand } from "./environment.js";
import { isAuthCommand } from "./runtime-command.js";
import { AUTH_SESSION_ID } from "./native-auth.js";

export const CANTELOP_INTEGRATION_PROTOCOL_VERSION = 2;
/** Default and maximum time a request command waits for its reply. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 300_000;
/** Longest idle window a Session may keep its Sandbox (seven days). */
export const MAX_KEEP_ALIVE_SECONDS = 604_800;
/** Bound on one encoded command envelope. */
export const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const ENVIRONMENT_NAME_PATTERN = /^(?!CANTELOP_)[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();

export const ENVIRONMENT_COMMAND_TYPES = Object.freeze(["app.environment.set", "app.environment.unset", "app.environment.status"] as const);
export function validateEnvironmentCommand(command: EnvironmentCommand): void {
  if (command.type === "app.environment.status") {
    if (!Number.isSafeInteger(command.revision) || command.revision < 0) throw new TypeError("Invalid environment revision");
    return;
  }
  if (typeof command.name !== "string" || !ENVIRONMENT_NAME_PATTERN.test(command.name) || typeof command.secret !== "boolean") throw new TypeError("Invalid environment name or kind");
  if (command.type === "app.environment.set" && (typeof command.value !== "string" || command.value.includes("\0") || encoder.encode(command.value).byteLength > MAX_ENVIRONMENT_VALUE_BYTES)) throw new TypeError("Invalid environment value");
}
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
/** Shared by App names and App-scoped Workspace slugs. */
export const SLUG_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function assertMessageID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !MESSAGE_ID_PATTERN.test(id)) throw new TypeError("Invalid Cantelop Message ID");
}
export function assertKeepAlive(value: unknown): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_KEEP_ALIVE_SECONDS)) {
    throw new TypeError(`keepAliveSeconds must be an integer between 0 and ${MAX_KEEP_ALIVE_SECONDS}`);
  }
}
export function workspaceSelector(value: unknown): WorkspaceSelector {
  if (!isRecord(value) || (value.id === undefined) === (value.slug === undefined)) throw new TypeError("A Workspace requires exactly one ID or slug");
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || !WORKSPACE_ID_PATTERN.test(value.id)) throw new TypeError("Invalid Cantelop Workspace ID");
    return Object.freeze({ id: value.id });
  }
  if (typeof value.slug !== "string" || !SLUG_PATTERN.test(value.slug)) throw new TypeError("Invalid Cantelop Workspace slug");
  return Object.freeze({ slug: value.slug });
}
export function assertSessionID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) throw new TypeError("Invalid Cantelop Session ID");
}
export function assertCursor(value: unknown): void {
  if (!isRecord(value) || typeof value.streamId !== "string" || !/^[0-9a-f]{32}$/.test(value.streamId) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || Object.keys(value).some(key => !["streamId", "sequence"].includes(key))) throw new TypeError("Invalid event cursor");
}
function assertTimeout(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_REQUEST_TIMEOUT_MS) throw new TypeError("Invalid timeoutMs");
}
/** Serialize once and validate the encoded form, which is exactly what Edge receives. */
export function encodeCommand(envelope: ProtocolEnvelope): string {
  const json = JSON.stringify(envelope);
  if (encoder.encode(json).byteLength > MAX_COMMAND_BYTES) throw new TypeError("Command exceeds 1 MiB");
  validateCommand(JSON.parse(json));
  return json;
}
export type ProtocolEnvelope = AppCommandEnvelope | AppEnvironmentEnvelope;
/** Validate untrusted Edge input before any private routing or provisioning. */
export function validateCommand(value: unknown): ProtocolEnvelope {
  if (!isRecord(value) || value.protocolVersion !== CANTELOP_INTEGRATION_PROTOCOL_VERSION || Object.keys(value).some(key => !["protocolVersion", "id", "workspace", "session", "command"].includes(key))) throw new TypeError("Invalid command envelope");
  assertMessageID(value.id);
  if (isRecord(value.command) && (ENVIRONMENT_COMMAND_TYPES as readonly unknown[]).includes(value.command.type)) {
    if (value.workspace !== null || value.session !== null) throw new TypeError("App environment commands require null Workspace and Session");
    const keys = value.command.type === "app.environment.set" ? ["type", "name", "value", "secret"] : value.command.type === "app.environment.unset" ? ["type", "name", "secret"] : ["type", "revision"];
    if (Object.keys(value.command).length !== keys.length || Object.keys(value.command).some(key => !keys.includes(key))) throw new TypeError("Invalid environment command fields");
    validateEnvironmentCommand(value.command as unknown as EnvironmentCommand);
    return value as unknown as AppEnvironmentEnvelope;
  }
  const workspace = workspaceSelector(value.workspace);
  if (Object.keys(value.workspace as object).length !== 1) throw new TypeError("Invalid Workspace selector");
  if (!isRecord(value.command) || typeof value.command.type !== "string") throw new TypeError("Invalid command");
  const command = value.command;
  let keys: string[];
  if ((WORKSPACE_COMMAND_TYPES as readonly unknown[]).includes(command.type)) {
    if (value.session !== null) throw new TypeError("Workspace command requires a null Session");
    if (command.type === "workspace.delete" && workspace.id === undefined) throw new TypeError("Workspace deletion requires a canonical ID");
    keys = ["type"];
  } else {
    if (!isRecord(value.session) || Object.keys(value.session).length !== 1) throw new TypeError("Invalid Session");
    assertSessionID(value.session.id);
    switch (command.type) {
      case "dispatch": case "steer": case "request":
        if (!("message" in command) || command.message === undefined) throw new TypeError("A message is required");
        assertKeepAlive(command.keepAliveSeconds);
        keys = ["type", "message", "keepAliveSeconds"];
        if (command.type === "request") {
          assertTimeout(command.timeoutMs);
          keys.push("timeoutMs");
        }
        break;
      case "auth":
        if (value.session.id !== AUTH_SESSION_ID) throw new TypeError("Auth requires the reserved Session");
        if (!isAuthCommand(command.auth)) throw new TypeError("Invalid auth command");
        assertTimeout(command.timeoutMs);
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
