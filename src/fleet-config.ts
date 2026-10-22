import type { ConfigurationContext, AppConfigurationDocument } from "./app-config.js";
import { parseAppConfiguration, MAX_CONFIG_BYTES } from "./app-config.js";
import { isRecord } from "./shared.js";
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
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("Fleet control URL must be an HTTPS origin (HTTP loopback is allowed for local dev)");
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

/** Uses the same captured, private integration profiles as Apps, never CLI owner credentials. */
export async function resolveFleetConfiguration(name: string, context: ConfigurationContext, profile?: string): Promise<ConfiguredFleet> {
  const documents: AppConfigurationDocument[] = [];
  if (context.injected) documents.push(context.injected);
  if (context.env.CANTELOP_APP_CONFIG !== undefined) {
    const text = context.env.CANTELOP_APP_CONFIG;
    if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) throw new FleetConfigurationError("fleet_configuration_invalid");
    try { documents.push(parseAppConfiguration(JSON.parse(text))); } catch { throw new FleetConfigurationError("fleet_configuration_invalid"); }
  }
  const find = () => {
    for (const document of documents) {
      const selected = profile ?? context.env.CANTELOP_PROFILE ?? document.activeProfile;
      const entry = Object.hasOwn(document.profiles, selected) ? document.profiles[selected]?.fleets?.find(fleet => fleet.name === name) : undefined;
      if (entry) {
        if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now()) throw new FleetConfigurationError("fleet_credentials_expired");
        return entry;
      }
    }
    return undefined;
  };
  const configured = find();
  if (configured) return configured;
  const runtime = globalThis as typeof globalThis & { process?: { versions?: { node?: string } } };
  const local = context.loadLocal ? await context.loadLocal() : runtime.process?.versions?.node
    ? await (await import("#cantelop-app-config")).loadNodeAppConfiguration(context.env) : {};
  if (local.document) documents.push(local.document);
  const resolved = find();
  if (!resolved) throw new FleetConfigurationError("fleet_not_configured");
  return resolved;
}
