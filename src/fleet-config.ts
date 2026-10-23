import type { ConfigurationContext } from "./app-config.js";
import { capturedConfigurationDocuments, loadLocalConfigurationDocument } from "./app-config.js";
import { isRecord, isServiceOrigin } from "./shared.js";
import { SLUG_PATTERN } from "./integration-protocol.js";
import { assertRuntimeID } from "./session-runtime-contract.js";

export class FleetConfigurationError extends Error {
  constructor(readonly code: "fleet_configuration_invalid" | "fleet_not_configured" | "fleet_credentials_expired" | "fleet_deployment_missing") {
    super({ fleet_configuration_invalid: "Fleet integration configuration is invalid", fleet_not_configured: "No integration configuration for the selected Fleet", fleet_credentials_expired: "Fleet credentials have expired", fleet_deployment_missing: "Fleet creation requires deployment package metadata supplied by the CLI" }[code]);
    this.name = "FleetConfigurationError";
  }
}
export class FleetError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`Fleet request failed: ${code}`);
    this.name = "FleetError";
  }
}
export interface ConfiguredFleet {
  readonly name: string;
  readonly id: string;
  readonly controlUrl: string;
  readonly accessToken: string;
  readonly expiresAt?: string;
  readonly packageId?: string;
  readonly runtimeId?: string;
}
export const fleetIdentifier = (value: unknown, prefix: string): value is string => typeof value === "string" && new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value);
export function controlOrigin(value: string): URL {
  const url = new URL(value);
  if (!isServiceOrigin(url)) throw new TypeError("Fleet control URL must be an HTTPS origin (HTTP loopback is allowed for local dev)");
  return url;
}
export function parseConfiguredFleets(value: unknown): readonly ConfiguredFleet[] {
  const invalid = (): never => { throw new FleetConfigurationError("fleet_configuration_invalid"); };
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  const names = new Set<string>(), ids = new Set<string>();
  return Object.freeze(value.map((item): ConfiguredFleet => {
    if (!isRecord(item) || typeof item.name !== "string" || !SLUG_PATTERN.test(item.name) || !fleetIdentifier(item.id, "flt") ||
        typeof item.controlUrl !== "string" || typeof item.accessToken !== "string" || !/^fsp_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(item.accessToken) ||
        names.has(item.name) || ids.has(item.id)) return invalid();
    try { controlOrigin(item.controlUrl); } catch { return invalid(); }
    if (item.expiresAt !== undefined && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)))) return invalid();
    if (item.packageId !== undefined && !fleetIdentifier(item.packageId, "pkg")) return invalid();
    if (item.runtimeId !== undefined) { try { assertRuntimeID(item.runtimeId); } catch { return invalid(); } }
    names.add(item.name); ids.add(item.id);
    return Object.freeze({ name: item.name, id: item.id, controlUrl: item.controlUrl, accessToken: item.accessToken,
      ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt as string }),
      ...(item.packageId === undefined ? {} : { packageId: item.packageId as string }),
      ...(item.runtimeId === undefined ? {} : { runtimeId: item.runtimeId as string }),
    });
  }));
}

/** Rejects expired credentials; checked on every use, including cached bindings. */
export function activeFleet(entry: ConfiguredFleet): ConfiguredFleet {
  if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now()) throw new FleetConfigurationError("fleet_credentials_expired");
  return entry;
}

/** Uses the same captured, private integration profiles as Apps, never CLI owner credentials. */
export async function resolveFleetConfiguration(name: string, context: ConfigurationContext, profile?: string): Promise<ConfiguredFleet> {
  const profileName = profile ?? context.env.CANTELOP_PROFILE;
  if (profileName !== undefined && !profileName) throw new FleetConfigurationError("fleet_configuration_invalid");
  const load = async <T>(read: () => T | Promise<T>): Promise<T> => {
    try { return await read(); } catch { throw new FleetConfigurationError("fleet_configuration_invalid"); }
  };
  const documents = await load(() => capturedConfigurationDocuments(context));
  const find = () => {
    for (const document of documents) {
      const selected = profileName ?? document.activeProfile;
      if (!Object.hasOwn(document.profiles, selected)) throw new FleetConfigurationError("fleet_not_configured");
      const fleets = document.profiles[selected]!.fleets;
      if (fleets === "invalid") throw new FleetConfigurationError("fleet_configuration_invalid");
      const entry = fleets?.find(fleet => fleet.name === name);
      if (entry) return activeFleet(entry);
    }
    return undefined;
  };
  const configured = find();
  if (configured) return configured;
  const local = await load(() => loadLocalConfigurationDocument(context));
  if (local) documents.push(local);
  const resolved = find();
  if (!resolved) throw new FleetConfigurationError("fleet_not_configured");
  return resolved;
}
