import type { AppConfigurationDocument } from "./app-config.js";

/** Hosts without filesystem profiles use injected context or environment configuration. */
export async function loadNodeAppConfiguration(
  _env: Readonly<Record<string, string | undefined>>,
): Promise<{ document?: AppConfigurationDocument }> {
  return {};
}
