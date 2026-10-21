/** Environment command contract; dependency-free so relay validators stay leaf-only. */
export const ENVIRONMENT_COMMAND_TYPES = Object.freeze(["app.environment.set", "app.environment.unset", "app.environment.status"] as const);
export type EnvironmentCommandType = (typeof ENVIRONMENT_COMMAND_TYPES)[number];
export type EnvironmentCommand =
  | { readonly type: "app.environment.set"; readonly name: string; readonly value: string; readonly secret: boolean }
  | { readonly type: "app.environment.unset"; readonly name: string; readonly secret: boolean }
  | { readonly type: "app.environment.status"; readonly revision: number };
export function validateEnvironmentCommand(command: EnvironmentCommand): void {
  if (command.type === "app.environment.status") {
    if (!Number.isSafeInteger(command.revision) || command.revision < 0) throw new TypeError("Invalid environment revision");
    return;
  }
  if (typeof command.name !== "string" || !/^(?!CANTELOP_)[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(command.name) || typeof command.secret !== "boolean") throw new TypeError("Invalid environment name or kind");
  if (command.type === "app.environment.set" && (typeof command.value !== "string" || command.value.includes("\0") || new TextEncoder().encode(command.value).length > 64 * 1024)) throw new TypeError("Invalid environment value");
}
