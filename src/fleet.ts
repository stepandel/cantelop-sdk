import { App } from "./app.js";
import type { AppOptions, AppConnection } from "./integration.js";
import type { ConfigurationContext, NormalizedAppOptions } from "./app-config.js";
import { createEdgeConnection, resolveEdgeConnection } from "./edge-connection.js";
import { assertRuntimeID } from "./session-runtime-contract.js";
import { isRecord } from "./shared.js";
import { FleetError, FleetConfigurationError, activeFleet, fleetIdentifier, resolveFleetConfiguration, type ConfiguredFleet } from "./fleet-config.js";

/** Shared application definition. Deployment and package selection belong to the CLI. */
export type FleetOptions<Message = unknown, Event = never, Reply = never, View = unknown> =
  Omit<AppOptions<Message, Event, Reply, View>, "connection" | "edgeUrl" | "accessToken">;
export type FleetInstanceSelector = { readonly externalKey: string; readonly id?: never } | { readonly id: string; readonly externalKey?: never };
export interface FleetOperationOptions { readonly signal?: AbortSignal }
export type FleetInstanceState = "deleted" | "deleting" | "suspended" | "upgrading" | "failed" | "ready" | "provisioning";
export interface FleetInstancePolicy {
  readonly active: boolean;
  readonly expiresAt: string;
  readonly maxSandboxes: number | null;
  readonly maxVcpus: number | null;
  readonly maxMemoryMib: number | null;
  readonly maxWorkspaces: number;
  readonly maxStorageBytes: number;
}
export interface FleetPolicyUpdate extends FleetOperationOptions {
  readonly expectedRevision: number;
  readonly sourceFence?: string;
  readonly policy: FleetInstancePolicy;
}
export interface FleetInstanceStatus {
  readonly id: string;
  readonly externalKey: string;
  readonly appId: string;
  readonly packageId: string;
  readonly nextPackageId?: string;
  readonly version: string;
  readonly state: FleetInstanceState;
  readonly runtimeId: string;
  readonly policyRevision: number;
  readonly enforcedRevision: number;
  readonly errorCode?: string;
}
const states = new Set(["deleted", "deleting", "suspended", "upgrading", "failed", "ready", "provisioning"]);
const validKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{16,128}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const invalidResponse = (): never => { throw new FleetError("invalid_fleet_response", 502); };
function status(value: unknown): FleetInstanceStatus {
  if (!isRecord(value) || !fleetIdentifier(value.id, "ins") || !fleetIdentifier(value.app_id, "app") || !fleetIdentifier(value.package_id, "pkg") ||
      !validKey(value.external_key) || typeof value.status !== "string" || !states.has(value.status) || typeof value.version !== "string" ||
      !revision(value.policy_revision) || !revision(value.enforced_revision) ||
      value.next_package_id != null && !fleetIdentifier(value.next_package_id, "pkg") ||
      value.error_code != null && (typeof value.error_code !== "string" || !/^[a-z0-9_]{1,128}$/.test(value.error_code))) return invalidResponse();
  try { assertRuntimeID(value.runtime_id); } catch { return invalidResponse(); }
  return Object.freeze({ id: value.id, externalKey: value.external_key, appId: value.app_id, packageId: value.package_id, version: value.version,
    runtimeId: value.runtime_id as string, state: value.status as FleetInstanceState, policyRevision: value.policy_revision, enforcedRevision: value.enforced_revision,
    ...(value.next_package_id == null ? {} : { nextPackageId: value.next_package_id as string }),
    ...(value.error_code == null ? {} : { errorCode: value.error_code as string }),
  });
}
function validatePolicy(options: FleetPolicyUpdate): void {
  const policy = options?.policy;
  if (!revision(options?.expectedRevision) || options.expectedRevision > 2147483646 || options.sourceFence !== undefined && (typeof options.sourceFence !== "string" || !/^[0-9]{1,19}$/.test(options.sourceFence) || BigInt(options.sourceFence) > 9223372036854775807n) ||
      !policy || typeof policy.active !== "boolean" || typeof policy.expiresAt !== "string" || !Number.isFinite(Date.parse(policy.expiresAt))) throw new TypeError("Invalid Fleet policy update");
  const limits = { maxSandboxes: 1000, maxVcpus: 10000, maxMemoryMib: 1_000_000, maxWorkspaces: 10000, maxStorageBytes: 1024 ** 4 };
  if (Object.keys(policy).some(key => !["active", "expiresAt", ...Object.keys(limits)].includes(key))) throw new TypeError("Invalid Fleet policy");
  for (const [key, max] of Object.entries(limits)) {
    const value = policy[key as keyof typeof limits];
    if (value === null && ["maxSandboxes", "maxVcpus", "maxMemoryMib"].includes(key)) continue;
    if (!revision(value) || (value as number) > max) throw new TypeError("Invalid Fleet policy limit");
  }
}

export class Fleet<Message = unknown, Event = never, Reply = never, View = unknown> {
  #pending: Promise<ConfiguredFleet> | undefined;
  constructor(private readonly options: NormalizedAppOptions<Message, Event, Reply, View>, private readonly context: ConfigurationContext, private readonly profile?: string) {}
  get name(): string { return this.options.name; }
  get runtime(): NormalizedAppOptions<Message, Event, Reply, View>["runtime"] { return this.options.runtime; }
  get runtimeId(): string | undefined { return this.options.runtimeId; }
  /** Bind the compiled application contract to a service relay, or the selected App profile for self-managed use. */
  connect(connection?: AppConnection): App<Message, Event, Reply, View> {
    if (connection !== undefined && (!connection || typeof connection.fetch !== "function")) throw new TypeError("An App connection is required");
    return new App(this.options, connection ?? resolveEdgeConnection(this.options, this.context, this.profile));
  }
  /** Select a service-role profile without mutating this definition or other references. */
  withProfile(profile: string): Fleet<Message, Event, Reply, View> {
    if (typeof profile !== "string" || !profile) throw new TypeError("A Fleet profile is required");
    return new Fleet(this.options, this.context, profile);
  }
  instance(selector: FleetInstanceSelector): FleetInstance<Message, Event, Reply, View> {
    if (!isRecord(selector) || Object.keys(selector).length !== 1 || !(validKey(selector.externalKey) || fleetIdentifier(selector.id, "ins"))) throw new TypeError("Select a Fleet instance by externalKey or id");
    return new FleetInstance(this.options, Object.freeze({ ...selector }), () => this.#configuration());
  }
  /** Resolve the binding once per Fleet; failures retry on the next operation. */
  async #configuration(): Promise<ConfiguredFleet> {
    this.#pending ??= resolveFleetConfiguration(this.name, this.context, this.profile).catch(error => { this.#pending = undefined; throw error; });
    return activeFleet(await this.#pending);
  }
}

/** A local reference; only explicit async operations contact the platform. */
export class FleetInstance<Message = unknown, Event = never, Reply = never, View = unknown> {
  constructor(private readonly definition: NormalizedAppOptions<Message, Event, Reply, View>, readonly selector: FleetInstanceSelector, private readonly configuration: () => Promise<ConfiguredFleet>) {}
  private async request(method: string, path: string, options: FleetOperationOptions = {}, body?: unknown): Promise<unknown> {
    options.signal?.throwIfAborted();
    const configuration = await this.configuration();
    options.signal?.throwIfAborted();
    const response = await fetch(new Request(`${configuration.controlUrl.replace(/\/$/, "")}/v1/fleets/${configuration.id}/${path}`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${configuration.accessToken}`, "Content-Type": "application/json" },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    // Bound decoded bodies, including chunked and compressed responses.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); return invalidResponse(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // Empty successes have no body; non-JSON error bodies keep their HTTP status.
    let value: unknown;
    try { value = size === 0 ? undefined : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { if (response.ok) return invalidResponse(); }
    if (!response.ok) {
      const code = isRecord(value) && typeof value.error === "string" && /^[a-z0-9_]{1,128}$/.test(value.error) ? value.error : "fleet_request_failed";
      throw new FleetError(code, response.status);
    }
    return value;
  }
  private path(): string {
    return this.selector.id === undefined ? `installations?externalKey=${encodeURIComponent(this.selector.externalKey)}` : `installations/${this.selector.id}`;
  }
  async status(options?: FleetOperationOptions): Promise<FleetInstanceStatus | undefined> {
    try {
      const result = status(await this.request("GET", this.path(), options));
      if (this.selector.id !== undefined ? result.id !== this.selector.id : result.externalKey !== this.selector.externalKey) return invalidResponse();
      return result;
    } catch (error) { if (error instanceof FleetError && error.status === 404 && error.code === "not_found") return undefined; throw error; }
  }
  async create(options?: FleetOperationOptions): Promise<FleetInstanceStatus> {
    if (this.selector.externalKey === undefined) throw new TypeError("Creating a Fleet instance requires an external key");
    options?.signal?.throwIfAborted();
    const configuration = await this.configuration();
    if (!configuration.packageId || this.definition.runtimeId !== undefined && configuration.runtimeId === undefined) throw new FleetConfigurationError("fleet_deployment_missing");
    this.assertRuntime(configuration.runtimeId);
    // An existing instance keeps its package: creation does not upgrade it.
    const result = status(await this.request("PUT", `installations/${encodeURIComponent(this.selector.externalKey)}`, options, { packageId: configuration.packageId }));
    if (result.externalKey !== this.selector.externalKey) return invalidResponse();
    this.assertRuntime(result.runtimeId);
    return result;
  }
  private assertRuntime(runtimeId: string | undefined): void {
    if (this.definition.runtimeId !== undefined && runtimeId !== this.definition.runtimeId) throw new FleetError("session_runtime_mismatch", 409);
  }
  private async requireStatus(options?: FleetOperationOptions): Promise<FleetInstanceStatus> {
    const result = await this.status(options);
    if (!result) throw new FleetError("not_found", 404);
    return result;
  }
  async setPolicy(options: FleetPolicyUpdate): Promise<{ readonly revision: number }> {
    validatePolicy(options);
    const target = this.selector.id ?? (await this.requireStatus(options)).id;
    const value = await this.request("PUT", `installations/${target}/policy`, options, { expectedRevision: options.expectedRevision, policy: options.policy, ...(options.sourceFence === undefined ? {} : { sourceFence: options.sourceFence }) });
    if (!isRecord(value) || !revision(value.revision)) return invalidResponse();
    return Object.freeze({ revision: value.revision });
  }
  async delete(options?: FleetOperationOptions): Promise<{ readonly state: "deleting" }> {
    const value = await this.request("DELETE", this.path(), options);
    if (value !== undefined && (!isRecord(value) || (this.selector.id === undefined ? value.deleted !== true : value.id !== this.selector.id || value.status !== "deleting"))) return invalidResponse();
    return Object.freeze({ state: "deleting" });
  }
  /** Raw relay connection; request bodies stream through unbuffered. */
  async connection(options?: FleetOperationOptions): Promise<AppConnection> {
    return this.edge(options, true);
  }
  private async edge(options: FleetOperationOptions | undefined, streamRequestBody: boolean): Promise<AppConnection> {
    const target = await this.requireStatus(options);
    this.assertRuntime(target.runtimeId);
    const value = await this.request("GET", `installations/${target.id}/credentials`, options);
    if (!isRecord(value) || value.appId !== target.appId || value.runtimeId !== target.runtimeId || typeof value.edgeUrl !== "string" || typeof value.accessToken !== "string") return invalidResponse();
    let connection: AppConnection;
    try { connection = createEdgeConnection({ edgeUrl: value.edgeUrl, accessToken: value.accessToken, runtimeId: value.runtimeId as string }, { streamRequestBody }); } catch { return invalidResponse(); }
    const runtimeId = this.definition.runtimeId ?? target.runtimeId;
    return Object.freeze({ async fetch(request: Request) {
      const supplied = request.headers.get("X-Cantelop-Session-Runtime");
      if (supplied !== null && supplied !== runtimeId) throw new FleetError("session_runtime_mismatch", 409);
      return connection.fetch(request);
    } });
  }
  async app(options?: FleetOperationOptions): Promise<App<Message, Event, Reply, View>> {
    // Commands are buffered so they keep a Content-Length.
    return new App(this.definition, await this.edge(options, false));
  }
}
