/// <reference types="node" />

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  build,
  context as createBuildContext,
  type BuildContext,
  type BuildOptions,
  type Plugin,
} from "esbuild";

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

export interface BuildLocalApiOptions extends BuildApiOptions {
  /** Numeric loopback origin for the local Cantelop Session bridge. */
  readonly runtimeOrigin: string;
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

export type LocalBuildComponent = "api" | "harness";

export interface LocalBuildEvent {
  readonly component: LocalBuildComponent;
  readonly error?: string;
}

export interface WatchLocalProjectOptions {
  readonly apiEntrypoint: string;
  readonly apiOutdir: string;
  readonly harnessEntrypoint: string;
  readonly harnessOutdir: string;
  readonly runtimeOrigin: string;
  readonly onBuild: (event: LocalBuildEvent) => void;
}

export interface LocalProjectWatcher {
  dispose(): Promise<void>;
}

/**
 * Bundles a customer API definition into a standard module Worker artifact.
 * Deployment credentials and provider-specific upload metadata deliberately
 * remain outside the SDK.
 */
export async function buildApi(options: BuildApiOptions): Promise<ApiArtifact> {
  return buildApiArtifact(options);
}

/**
 * Bundles a customer API definition for the local worker host. Calls to the
 * platform-owned runtime hostname are redirected to a loopback Session bridge;
 * customer API source and the production artifact remain unchanged.
 */
export async function buildLocalApi(
  options: BuildLocalApiOptions,
): Promise<ApiArtifact> {
  const runtimeOrigin = localRuntimeOrigin(options.runtimeOrigin);
  return buildApiArtifact(options, runtimeOrigin);
}

async function buildApiArtifact(
  options: BuildApiOptions,
  runtimeOrigin?: string,
): Promise<ApiArtifact> {
  const entrypoint = path.resolve(options.entrypoint);
  const outdir = path.resolve(options.outdir);
  if (entrypoint === outdir || path.dirname(entrypoint) === outdir) {
    throw new TypeError("API artifact output must not contain the source entrypoint");
  }
  await mkdir(outdir, { recursive: true });

  const mainModule = path.join(outdir, MAIN_MODULE);
  await build(apiBuildOptions(entrypoint, mainModule, runtimeOrigin));

  const manifest = await writeApiManifest(outdir);
  const manifestFile = path.join(outdir, MANIFEST_FILE);

  return Object.freeze({
    directory: outdir,
    mainModule,
    manifestFile,
    manifest: Object.freeze(manifest),
  });
}

function apiBuildOptions(
  entrypoint: string,
  mainModule: string,
  runtimeOrigin?: string,
): BuildOptions {
  return {
    stdin: {
      contents: [
        `import definition from ${JSON.stringify(entrypoint)};`,
        `import { createApiWorker } from ${JSON.stringify(EDGE_ADAPTER_MODULE)};`,
        ...(runtimeOrigin === undefined ? [
          "export default createApiWorker(definition);",
        ] : [
          `const runtimeOrigin = ${JSON.stringify(runtimeOrigin)};`,
          "const runtimeFetch = (request) => {",
          "  const source = new URL(request.url);",
          "  return fetch(new Request(new URL(source.pathname + source.search, runtimeOrigin), request));",
          "};",
          "export default createApiWorker(definition, { fetch: runtimeFetch });",
        ]),
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
  };
}

async function writeApiManifest(outdir: string): Promise<ApiArtifactManifest> {
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
  return manifest;
}

function localRuntimeOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new TypeError("Local runtime origin must be a numeric HTTP loopback origin");
  }
  const numericLoopback = origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  if (
    origin.protocol !== "http:" ||
    !numericLoopback ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new TypeError("Local runtime origin must be a numeric HTTP loopback origin");
  }
  return origin.origin;
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
  await build(harnessBuildOptions(entrypoint, mainModule));

  const manifest = await writeHarnessManifest(outdir, mainModule);
  const manifestFile = path.join(outdir, HARNESS_MANIFEST_FILE);

  return Object.freeze({
    directory: outdir,
    mainModule,
    manifestFile,
    manifest: Object.freeze(manifest),
  });
}

function harnessBuildOptions(entrypoint: string, mainModule: string): BuildOptions {
  return {
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
  };
}

async function writeHarnessManifest(
  outdir: string,
  mainModule: string,
): Promise<HarnessArtifactManifest> {
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
  return manifest;
}

export async function watchLocalProject(
  options: WatchLocalProjectOptions,
): Promise<LocalProjectWatcher> {
  const runtimeOrigin = localRuntimeOrigin(options.runtimeOrigin);
  const apiEntrypoint = path.resolve(options.apiEntrypoint);
  const apiOutdir = path.resolve(options.apiOutdir);
  const harnessEntrypoint = path.resolve(options.harnessEntrypoint);
  const harnessOutdir = path.resolve(options.harnessOutdir);
  await Promise.all([
    mkdir(apiOutdir, { recursive: true }),
    mkdir(harnessOutdir, { recursive: true }),
  ]);

  const contexts: BuildContext[] = [];
  try {
    contexts.push(
      await watchedContext(
        "api",
        apiBuildOptions(
          apiEntrypoint,
          path.join(apiOutdir, MAIN_MODULE),
          runtimeOrigin,
        ),
        () => writeApiManifest(apiOutdir),
        options.onBuild,
      ),
    );
    contexts.push(
      await watchedContext(
        "harness",
        harnessBuildOptions(
          harnessEntrypoint,
          path.join(harnessOutdir, HARNESS_MAIN_MODULE),
        ),
        () => writeHarnessManifest(
          harnessOutdir,
          path.join(harnessOutdir, HARNESS_MAIN_MODULE),
        ),
        options.onBuild,
      ),
    );
  } catch (error) {
    await Promise.all(contexts.map((buildContext) => buildContext.dispose()));
    throw error;
  }
  return Object.freeze({
    async dispose() {
      await Promise.all(contexts.map((buildContext) => buildContext.dispose()));
    },
  });
}

async function watchedContext(
  component: LocalBuildComponent,
  options: BuildOptions,
  finalize: () => Promise<unknown>,
  onBuild: (event: LocalBuildEvent) => void,
): Promise<BuildContext> {
  let initial = true;
  let resolveInitial!: () => void;
  let rejectInitial!: (error: Error) => void;
  const initialBuild = new Promise<void>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  const plugin: Plugin = {
    name: `cantelop-local-${component}-watch`,
    setup(build) {
      build.onEnd(async (result) => {
        let error = result.errors.map((value) => value.text).join("\n");
        if (error === "") {
          try {
            await finalize();
          } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
          }
        }
        if (initial) {
          initial = false;
          if (error === "") resolveInitial();
          else rejectInitial(new Error(error));
          return;
        }
        onBuild(Object.freeze({ component, ...(error === "" ? {} : { error }) }));
      });
    },
  };
  const buildContext = await createBuildContext({
    ...options,
    plugins: [...(options.plugins ?? []), plugin],
  });
  await buildContext.watch();
  try {
    await initialBuild;
  } catch (error) {
    await buildContext.dispose();
    throw error;
  }
  return buildContext;
}
