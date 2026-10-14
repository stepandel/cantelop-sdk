import { assertRuntimeID } from "./session-runtime-contract.js";

/** Application wire contract, independent of the deployed implementation. */
export interface AppCompatibility {
  readonly version: string;
  /** Older contracts this runtime still implements, including their semantics. */
  readonly accepts?: readonly string[];
  /** Explicit one-time adoption of clients generated before contract versioning. */
  readonly legacyRuntimes?: Readonly<Record<string, string>>;
}

export const CONTRACT_HEADER = "X-Cantelop-Session-Contract";
export function assertContractVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value))
    throw new TypeError("Invalid App contract version");
}

export function validateCompatibility(value: AppCompatibility | undefined): AppCompatibility | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["version", "accepts", "legacyRuntimes"].includes(key)))
    throw new TypeError("Invalid App compatibility declaration");
  assertContractVersion(value.version);
  const accepts = value.accepts ?? [];
  if (!Array.isArray(accepts) || accepts.length > 32 || new Set(accepts).size !== accepts.length)
    throw new TypeError("Invalid accepted App contracts");
  for (const version of accepts) assertContractVersion(version);
  const legacy = value.legacyRuntimes ?? {};
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy) || Object.keys(legacy).length > 128)
    throw new TypeError("Invalid legacy runtime mapping");
  for (const [runtime, version] of Object.entries(legacy)) {
    assertRuntimeID(runtime); assertContractVersion(version);
    if (version !== value.version && !accepts.includes(version))
      throw new TypeError("Legacy runtime must map to an accepted App contract");
  }
  return Object.freeze({ version: value.version,
    ...(value.accepts === undefined ? {} : { accepts: Object.freeze([...accepts]) }),
    ...(value.legacyRuntimes === undefined ? {} : { legacyRuntimes: Object.freeze({ ...legacy }) }) });
}

/** A supplied contract always wins; a legacy fingerprint cannot override it. */
export function requestContract(headers: Headers, runtimeId: string, compatibility?: AppCompatibility): string | undefined {
  const version = headers.get(CONTRACT_HEADER);
  const runtime = headers.get("X-Cantelop-Session-Runtime");
  if (!compatibility) {
    if (version !== null || runtime !== runtimeId) throw new TypeError("session_runtime_mismatch");
    return undefined;
  }
  const selected = version ?? (runtime === runtimeId ? compatibility.version :
    runtime !== null && Object.hasOwn(compatibility.legacyRuntimes ?? {}, runtime) ? compatibility.legacyRuntimes![runtime] : undefined);
  if (!selected || selected !== compatibility.version && !compatibility.accepts?.includes(selected))
    throw new TypeError("session_contract_mismatch");
  return selected;
}
