export interface AppEnvironmentDeclaration {
  readonly default?: string;
  readonly secret?: boolean;
  readonly required?: boolean;
}
export interface AppDeploymentConfiguration {
  readonly environment?: Readonly<Record<string, AppEnvironmentDeclaration>>;
  /** Project-relative Dockerfile for native dependencies and assets. */
  readonly dockerfile?: string;
}

export function validateAppDeploymentConfiguration(value: AppDeploymentConfiguration): AppDeploymentConfiguration {
  const environment: Record<string, AppEnvironmentDeclaration> = {};
  if (value.environment !== undefined) {
    if (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)) throw new TypeError("Invalid App environment declarations");
    for (const [name, declaration] of Object.entries(value.environment)) {
      if (!/^(?!CANTELOP_)[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !declaration || typeof declaration !== "object" || Array.isArray(declaration) ||
          Object.keys(declaration).some(key => !["default", "secret", "required"].includes(key)) ||
          declaration.default !== undefined && typeof declaration.default !== "string" ||
          declaration.secret !== undefined && typeof declaration.secret !== "boolean" ||
          declaration.required !== undefined && typeof declaration.required !== "boolean" ||
          declaration.secret === true && declaration.default !== undefined) throw new TypeError("Invalid App environment declaration");
      Object.defineProperty(environment, name, { value: Object.freeze({ ...declaration }), enumerable: true });
    }
  }
  if (value.dockerfile !== undefined && (typeof value.dockerfile !== "string" || !value.dockerfile || value.dockerfile.includes("\\") || value.dockerfile.includes("\0") || (value.dockerfile.startsWith("/") || /^[a-z]:/i.test(value.dockerfile)) || value.dockerfile.split("/").includes(".."))) throw new TypeError("App Dockerfile must be a project-relative path");
  return Object.freeze({ ...(value.environment === undefined ? {} : { environment: Object.freeze(environment) }), ...(value.dockerfile === undefined ? {} : { dockerfile: value.dockerfile }) });
}
