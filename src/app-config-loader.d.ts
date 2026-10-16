declare module "#cantelop-app-config" {
  export function loadNodeAppConfiguration(
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<{
    document?: import("./app-config.js").AppConfigurationDocument;
  }>;
}
