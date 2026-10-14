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
/** Native auth contracts share the wire field, so App contracts cannot claim their namespace. */
const RESERVED_CONTRACT = /^native-auth\./i;
export function assertContractVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value) || RESERVED_CONTRACT.test(value))
    throw new TypeError("Invalid App contract version");
}
/** Declarations are literal data; Maps, class instances and null would otherwise drop entries silently. */
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateCompatibility(value: AppCompatibility | undefined): AppCompatibility | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value) || Object.keys(value).some(key => !["version", "accepts", "legacyRuntimes"].includes(key)))
    throw new TypeError("Invalid App compatibility declaration");
  assertContractVersion(value.version);
  const accepts: unknown = value.accepts === undefined ? [] : value.accepts;
  if (!Array.isArray(accepts) || accepts.length > 32 || new Set(accepts).size !== accepts.length)
    throw new TypeError("Invalid accepted App contracts");
  for (const version of accepts) assertContractVersion(version);
  const legacy: unknown = value.legacyRuntimes === undefined ? {} : value.legacyRuntimes;
  if (!plainObject(legacy) || Object.keys(legacy).length > 128)
    throw new TypeError("Invalid legacy runtime mapping");
  for (const [runtime, version] of Object.entries(legacy)) {
    assertRuntimeID(runtime); assertContractVersion(version);
    if (version !== value.version && !accepts.includes(version))
      throw new TypeError("Legacy runtime must map to an accepted App contract");
  }
  return Object.freeze({ version: value.version,
    ...(value.accepts === undefined ? {} : { accepts: Object.freeze([...accepts]) }),
    ...(value.legacyRuntimes === undefined ? {} : { legacyRuntimes: Object.freeze({ ...legacy }) as Readonly<Record<string, string>> }) });
}

export type ContractSelection =
  | { readonly version: string | undefined }
  | { readonly error: "session_runtime_mismatch" | "session_contract_mismatch" | "session_contract_not_declared" };

/** A supplied contract always wins; a legacy fingerprint cannot override it. */
export function requestContract(headers: Headers, runtimeId: string, compatibility?: AppCompatibility): ContractSelection {
  const version = headers.get(CONTRACT_HEADER);
  const runtime = headers.get("X-Cantelop-Session-Runtime");
  if (!compatibility) {
    // The client opted in to contracts but this deployment did not; its fingerprint is not the problem.
    if (version !== null) return { error: "session_contract_not_declared" };
    return runtime === runtimeId ? { version: undefined } : { error: "session_runtime_mismatch" };
  }
  const selected = version ?? (runtime === runtimeId ? compatibility.version :
    runtime !== null && Object.hasOwn(compatibility.legacyRuntimes ?? {}, runtime) ? compatibility.legacyRuntimes![runtime] : undefined);
  if (!selected || selected !== compatibility.version && !compatibility.accepts?.includes(selected))
    return { error: "session_contract_mismatch" };
  return { version: selected };
}
