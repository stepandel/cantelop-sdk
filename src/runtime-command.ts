/** SDK commands are opaque application payloads to the delivery transport. */
import type { NativeAuthCommand } from "./native-auth.js";
export type RuntimeCommand<Message> =
  | {
      readonly type: "dispatch" | "steer";
      readonly message: Message;
    }
  | { readonly type: "cancel" }
  | { readonly type: "auth"; readonly auth: NativeAuthCommand };

export function encodeRuntimeCommand<Message>(
  command: RuntimeCommand<Message>,
): unknown {
  return { __cantelop_command: 2, ...command };
}

export function decodeRuntimeCommand<Message>(
  value: unknown,
): RuntimeCommand<Message> {
  // Raw actor messages remain ordinary dispatch input for existing integrations.
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("__cantelop_command" in value)
  )
    return { type: "dispatch", message: value as Message };
  const command = value as Record<string, unknown>;
  const keys =
    command.type === "cancel"
      ? ["__cantelop_command", "type"]
      : command.type === "auth" ? ["__cantelop_command", "type", "auth"]
      : ["__cantelop_command", "type", "message"];
  if (
    command.__cantelop_command !== 2 ||
    Object.keys(command).some((key) => !keys.includes(key))
  )
    throw new TypeError("Invalid SDK runtime command");
  if (command.type === "cancel") return { type: "cancel" };
  if (command.type === "auth" && isAuthCommand(command.auth)) return { type: "auth", auth: command.auth };
  if (
    (command.type === "dispatch" || command.type === "steer") &&
    command.message !== undefined
  )
    return {
      type: command.type,
      message: command.message as Message,
    };
  throw new TypeError("Invalid SDK runtime command");
}

export function isAuthCommand(value: unknown): value is NativeAuthCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const base = command.type === "login" ? ["type", "method", "force"]
    : command.type === "submit" ? ["type", "attemptId", "code"]
    : command.type === "cancel" ? ["type", "attemptId"] : ["type"];
  if (Object.keys(command).some(key => !base.includes(key))) return false;
  if (command.type === "methods" || command.type === "status" || command.type === "logout") return true;
  if (command.type === "login") return typeof command.method === "string" && command.method.length <= 64 && (command.force === undefined || typeof command.force === "boolean");
  const attemptId = typeof command.attemptId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(command.attemptId);
  if (command.type === "cancel") return attemptId;
  if (command.type === "submit") return attemptId && typeof command.code === "string" && /^[\x21-\x7e]{1,2048}$/.test(command.code);
  return false;
}
