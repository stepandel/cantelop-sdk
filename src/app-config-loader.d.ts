declare module "#cantelop-app-config" {
  export function loadNodeAppConfiguration(
    env: Readonly<Record<string, string | undefined>>,
    options: { readonly discoverProject: boolean; readonly directory?: string },
  ): Promise<{
    document?: import("./app-config.js").AppConfigurationDocument;
    projectApp?: import("./integration.js").AppSelector;
  }>;
}
