import type { AppConfigurationDocument } from "./app-config.js";
import type { AppSelector } from "./integration.js";

/** Hosts without filesystem profiles use injected context or environment configuration. */
export async function loadNodeAppConfiguration(
  _env: Readonly<Record<string, string | undefined>>,
  _options: { readonly discoverProject: boolean; readonly directory?: string },
): Promise<{ document?: AppConfigurationDocument; projectApp?: AppSelector }> {
  return {};
}
