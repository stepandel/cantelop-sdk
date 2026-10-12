/** SDK commands are opaque application payloads to the delivery transport. */
export type RuntimeCommand<Message> =
  | {
      readonly type: "dispatch" | "steer";
      readonly message: Message;
    }
  | { readonly type: "cancel" };

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
      : ["__cantelop_command", "type", "message"];
  if (
    command.__cantelop_command !== 2 ||
    Object.keys(command).some((key) => !keys.includes(key))
  )
    throw new TypeError("Invalid SDK runtime command");
  if (command.type === "cancel") return { type: "cancel" };
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
