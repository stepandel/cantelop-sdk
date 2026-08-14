/// <reference types="node" />

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const MANIFEST_SCHEMA_VERSION = 1;
const EXECUTION_PROTOCOL_VERSION = 2;
const MAIN_MODULE = "worker.mjs";
const MANIFEST_FILE = "cantelop-api.json";
const HARNESS_MAIN_MODULE = "harness.mjs";
const HARNESS_MANIFEST_FILE = "cantelop-harness.json";
const EDGE_ADAPTER_MODULE = fileURLToPath(new URL("./edge.js", import.meta.url));
const HARNESS_STARTUP_STATE_KEY = "dev.cantelop.sdk.harness-startup.v1";

export interface BuildApiOptions {
  readonly entrypoint: string;
  readonly outdir: string;
}

export interface ApiArtifactManifest {
  readonly schema_version: 1;
  readonly kind: "cantelop-edge-api";
  readonly main_module: "worker.mjs";
  readonly execution_protocol_version: 2;
}

export interface ApiArtifact {
  readonly directory: string;
  readonly mainModule: string;
  readonly manifestFile: string;
  readonly manifest: ApiArtifactManifest;
}

export interface BuildHarnessOptions {
  readonly entrypoint: string;
  readonly outdir: string;
}

export interface HarnessArtifactManifest {
  readonly schema_version: 1;
  readonly kind: "cantelop-native-harness";
  readonly main_module: "harness.mjs";
  readonly execution_protocol_version: 2;
  readonly bundled_bytes: number;
}

export interface HarnessArtifact {
  readonly directory: string;
  readonly mainModule: string;
  readonly manifestFile: string;
  readonly manifest: HarnessArtifactManifest;
}

/**
 * Bundles a customer API definition into a standard module Worker artifact.
 * Deployment credentials and provider-specific upload metadata deliberately
 * remain outside the SDK.
 */
export async function buildApi(options: BuildApiOptions): Promise<ApiArtifact> {
  const entrypoint = path.resolve(options.entrypoint);
  const outdir = path.resolve(options.outdir);
  if (entrypoint === outdir || path.dirname(entrypoint) === outdir) {
    throw new TypeError("API artifact output must not contain the source entrypoint");
  }
  await mkdir(outdir, { recursive: true });

  const mainModule = path.join(outdir, MAIN_MODULE);
  await build({
    stdin: {
      contents: [
        `import definition from ${JSON.stringify(entrypoint)};`,
        `import { createApiWorker } from ${JSON.stringify(EDGE_ADAPTER_MODULE)};`,
        "export default createApiWorker(definition);",
      ].join("\n"),
      loader: "ts",
      resolveDir: path.dirname(entrypoint),
      sourcefile: "cantelop-api-bootstrap.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: mainModule,
    sourcemap: "external",
    legalComments: "none",
    logLevel: "silent",
  });

  const manifest: ApiArtifactManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind: "cantelop-edge-api",
    main_module: MAIN_MODULE,
    execution_protocol_version: EXECUTION_PROTOCOL_VERSION,
  };
  const manifestFile = path.join(outdir, MANIFEST_FILE);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });

  return Object.freeze({
    directory: outdir,
    mainModule,
    manifestFile,
    manifest: Object.freeze(manifest),
  });
}

/**
 * Bundles a native SDK harness into one Bun-loadable module. Doing this at
 * deploy time removes node_modules graph discovery and TypeScript transforms
 * from the VM's request-critical startup path.
 */
export async function buildHarness(
  options: BuildHarnessOptions,
): Promise<HarnessArtifact> {
  const entrypoint = path.resolve(options.entrypoint);
  const outdir = path.resolve(options.outdir);
  if (entrypoint === outdir || path.dirname(entrypoint) === outdir) {
    throw new TypeError(
      "harness artifact output must not contain the source entrypoint",
    );
  }
  await mkdir(outdir, { recursive: true });

  const mainModule = path.join(outdir, HARNESS_MAIN_MODULE);
  await build({
    stdin: {
      contents: [
        `const key = Symbol.for(${JSON.stringify(HARNESS_STARTUP_STATE_KEY)});`,
        "const state = { started: process.hrtime.bigint(), seen: new Set() };",
        "Object.defineProperty(globalThis, key, { value: state, configurable: false });",
        "const mark = (stage) => {",
        "  if (state.seen.has(stage)) return;",
        "  state.seen.add(stage);",
        "  const now = process.hrtime.bigint();",
        "  process.stderr.write(`${JSON.stringify({ component: \"cantelop.sdk\", event: \"harness_startup_stage\", stage, elapsed_us: Number((now - state.started) / 1000n) })}\\n`);",
        "};",
        "mark(\"bun_entry\");",
        `await import(${JSON.stringify(entrypoint)});`,
        "mark(\"module_evaluated\");",
      ].join("\n"),
      loader: "ts",
      resolveDir: path.dirname(entrypoint),
      sourcefile: "cantelop-harness-bootstrap.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "esnext",
    conditions: ["bun", "node", "import", "default"],
    external: ["bun:*"],
    outfile: mainModule,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });

  const bundledBytes = (await stat(mainModule)).size;
  const manifest: HarnessArtifactManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind: "cantelop-native-harness",
    main_module: HARNESS_MAIN_MODULE,
    execution_protocol_version: EXECUTION_PROTOCOL_VERSION,
    bundled_bytes: bundledBytes,
  };
  const manifestFile = path.join(outdir, HARNESS_MANIFEST_FILE);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });

  return Object.freeze({
    directory: outdir,
    mainModule,
    manifestFile,
    manifest: Object.freeze(manifest),
  });
}
