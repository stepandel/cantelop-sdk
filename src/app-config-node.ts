/// <reference types="node" />

// Loaded lazily only for backend file discovery; never part of the generated Edge Worker.
import { open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppConfigurationError, parseAppConfiguration, type AppConfigurationDocument } from "./app-config.js";
import type { AppSelector } from "./integration.js";
const MAX_BYTES = 1024 * 1024;

export async function loadNodeAppConfiguration(env: Readonly<Record<string, string | undefined>>, options: { readonly discoverProject: boolean; readonly directory?: string }): Promise<{ document?: AppConfigurationDocument; projectApp?: AppSelector }> {
  const configured = env.CANTELOP_INTEGRATION_CONFIG;
  const configDirectory = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32" ? env.APPDATA : env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const profilePath = configured ?? (env.CANTELOP_CONFIG === undefined
    ? configDirectory === undefined ? undefined : path.join(configDirectory, "cantelop", "integration.json")
    : path.join(path.dirname(env.CANTELOP_CONFIG), "integration.json"));
  let document: AppConfigurationDocument | undefined;
  if (profilePath !== undefined) {
    try {
      const handle = await open(profilePath, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new AppConfigurationError("app_configuration_invalid");
        const bytes = new Uint8Array(MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > MAX_BYTES) throw new AppConfigurationError("app_configuration_invalid");
        document = parseAppConfiguration(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw new AppConfigurationError("app_configuration_invalid");
      if (configured !== undefined) throw new AppConfigurationError("app_configuration_invalid");
    }
  }
  if (!options.discoverProject) return document === undefined ? {} : { document };
  let projectApp: AppSelector | undefined;
  let directory = options.directory ?? process.cwd();
  while (true) {
    const projectPath = env.CANTELOP_PROJECT_CONFIG ?? path.join(directory, "cantelop.json");
    try {
      const source = await readFile(projectPath, "utf8");
      if (new TextEncoder().encode(source).byteLength > MAX_BYTES) throw new Error();
      const value = JSON.parse(source) as { app?: unknown };
      if (typeof value.app !== "string" || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.app)) throw new Error();
      projectApp = { slug: value.app }; break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT" || env.CANTELOP_PROJECT_CONFIG !== undefined) throw new AppConfigurationError("app_configuration_invalid");
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { ...(document === undefined ? {} : { document }), ...(projectApp === undefined ? {} : { projectApp }) };
}
