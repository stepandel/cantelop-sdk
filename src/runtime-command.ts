/** SDK commands are opaque application payloads to the delivery transport. */
import { LOGIN_ID_PATTERN, TERMINAL_ID_PATTERN, type AuthCommand } from "./native-auth.js";
export type RuntimeCommand<Message> =
  | {
      readonly type: "dispatch" | "steer";
      readonly message: Message;
    }
  | { readonly type: "cancel" }
  | { readonly type: "auth"; readonly auth: AuthCommand };

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

export function isAuthCommand(value: unknown): value is AuthCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const keys = command.type === "close" ? ["type", "terminalId"] : command.type === "login" ? ["type","force"]
    : command.type === "code" ? ["type","attemptId","code"] : command.type === "cancel" ? ["type","attemptId"] : ["type"];
  if (Object.keys(command).some(key => !keys.includes(key))) return false;
  if (command.type === "login") return command.force === undefined || typeof command.force === "boolean";
  if (command.type === "code" || command.type === "cancel") {
    if (typeof command.attemptId !== "string" || !LOGIN_ID_PATTERN.test(command.attemptId)) return false;
    return command.type === "cancel" || typeof command.code === "string" && command.code.length>0 && command.code.length<=2048 && !/[\r\n\x00-\x1f\x7f]/.test(command.code);
  }
  if (command.type === "status" || command.type === "logout" || command.type === "terminal") return true;
  return command.type === "close" && typeof command.terminalId === "string" && TERMINAL_ID_PATTERN.test(command.terminalId);
}
