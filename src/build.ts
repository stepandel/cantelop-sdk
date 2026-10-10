import type { AppDeploymentConfiguration } from "./app-definition.js";
/// <reference types="node" />

/**
 * Build tooling reserved for the Cantelop CLI, not a supported application API.
 * Application authors should use `cantelop dev` and `cantelop deploy`.
 * Compatibility is governed by CANTELOP_CLI_BUILD_PROTOCOL_VERSION.
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileClientDefinition as readRuntimeDefinition, compileAppDefinitions, RuntimeContractError } from "./compiler.js";
export { createCantelopCompilerPlugin } from "./compiler.js";
import { fileURLToPath } from "node:url";

import {
  build,
  context as createBuildContext,
  type BuildContext,
  type BuildOptions,
  type Plugin,
} from "esbuild";

import type { ApplicationDatabaseSchema } from "./database-schema.js";
export { createApplicationSchema, validateApplicationSchema, applicationMigrationSQL, synchronizeApplicationSchema, synchronizeLocalDatabase, DatabaseSchemaError } from "./database-schema.js";
export type { ApplicationDatabaseSchema, AppliedApplicationMigration } from "./database-schema.js";
export const CANTELOP_DATABASE_SCHEMA_PROTOCOL_VERSION = 1;

const BUILD_EVALUATION_TIMEOUT_MS = 10_000;
const BUILD_ARTIFACT_MARKER = "cantelop-build-artifact:";
const SESSION_RUNTIME_MAIN_MODULE = "session-runtime.mjs";
const SESSION_MANIFEST_FILE = "cantelop-runtime.json";
const SESSION_RUNTIME_ADAPTER_MODULE = fileURLToPath(new URL("./runtime.js", import.meta.url));
const SESSION_RUNTIME_STARTUP_STATE_KEY = "dev.cantelop.sdk.session-runtime-startup.v1";

// The CLI checks this exact protocol before using the build module. Increment
// it when an incompatible build/watch contract is introduced.
export const CANTELOP_CLI_BUILD_PROTOCOL_VERSION = 6;

/** Local credentials and HTTP libSQL support required by database-enabled CLI dev. */
export const CANTELOP_LOCAL_DATABASE_PROTOCOL_VERSION = 1;

export interface BuildSessionRuntimeOptions {
  readonly definition: string;
  /** Required when a definition module exports multiple Apps. */
  readonly app?: string;
  readonly outdir: string;
  /** Manifest/project root; inferred from the Session entrypoint when omitted. */
  readonly projectRoot?: string;
}

export interface SessionRuntimeManifest extends AppDeploymentConfiguration {
  readonly schema_version: 1;
  readonly kind: "cantelop-session-runtime";
  readonly main_module: "session-runtime.mjs";
  readonly cli_build_protocol_version: 6;
  readonly runtime_protocol_version: 2;
  readonly integration_protocol_version: 2;
  readonly session_runtime_id: string;
  readonly app_name: string;
  /** Advertised only after coordinated actor scheduling, attribution and projection support. */
  readonly capabilities: Readonly<{ priority: false; messageCancellation: false; durableView: false }>;
  readonly database_schema?: ApplicationDatabaseSchema;
}

export interface SessionRuntimeArtifact {
  readonly directory: string;
  readonly mainModule: string;
  readonly manifestFile: string;
  readonly manifest: SessionRuntimeManifest;
}

export type LocalBuildComponent = "session-runtime" | "database-schema";

export interface LocalBuildEvent {
  readonly component: LocalBuildComponent;
  readonly error?: string;
}

export interface WatchLocalProjectOptions {
  readonly sessionDefinition: string;
  readonly app?: string;
  readonly sessionRuntimeOutdir: string;
  readonly projectRoot?: string;
  readonly onBuild: (event: LocalBuildEvent) => void;
}

export interface LocalProjectWatcher {
  dispose(): Promise<void>;
}

export interface BuildEdgeApiOptions {
  readonly definition: string;
  /** Required when a definition module exports multiple Apps. */
  readonly app?: string;
  readonly outdir: string;
  /** Local CLI only: a numeric loopback Session bridge origin. */
  readonly runtimeOrigin?: string;
}
export interface EdgeApiArtifact {
  readonly directory: string;
  readonly mainModule: string;
  readonly manifestFile: string;
  readonly manifest: Readonly<{
    schema_version: 1;
    kind: "cantelop-protocol-edge";
    main_module: "worker.mjs";
    cli_build_protocol_version: 6;
    integration_protocol_version: 2;
    session_runtime_id: string;
    required_bindings: readonly ["CANTELOP_INTEGRATION_TOKEN"];
    default_keep_alive_binding: "CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS";
  }>;
}

/** Generates the protocol-owned App Worker; there is no customer API entrypoint. */
export async function buildEdgeApi(options: BuildEdgeApiOptions): Promise<EdgeApiArtifact> {
  const runtime = await readRuntimeDefinition(path.resolve(options.definition), options.app);
  const outdir = path.resolve(options.outdir);
  if (options.runtimeOrigin !== undefined) {
    const url = new URL(options.runtimeOrigin);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("Local runtime origin must be a numeric HTTP loopback origin");
    }
  }
  await mkdir(outdir, { recursive: true });
  const mainModule = path.join(outdir, "worker.mjs");
  const adapter = fileURLToPath(new URL("./protocol-edge.js", import.meta.url));
  await build({
    stdin: { contents: `import { createProtocolWorker } from ${JSON.stringify(adapter)};\nexport default createProtocolWorker(${JSON.stringify({ runtimeId: runtime.definition.id, ...(options.runtimeOrigin === undefined ? {} : { runtimeOrigin: options.runtimeOrigin }) })});`, resolveDir: outdir },
    bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: mainModule, logLevel: "silent",
  });
  const manifest: EdgeApiArtifact["manifest"] = Object.freeze({
    schema_version: 1, kind: "cantelop-protocol-edge", main_module: "worker.mjs",
    cli_build_protocol_version: 6, integration_protocol_version: 2, session_runtime_id: runtime.definition.id, app_name: runtime.definition.name,
    ...(runtime.definition.environment === undefined ? {} : { environment: runtime.definition.environment }),
    ...(runtime.definition.dockerfile === undefined ? {} : { dockerfile: runtime.definition.dockerfile }),
    required_bindings: Object.freeze(["CANTELOP_INTEGRATION_TOKEN"] as const),
    default_keep_alive_binding: "CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS",
  });
  const manifestFile = path.join(outdir, "cantelop-edge.json");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return Object.freeze({ directory: outdir, mainModule, manifestFile, manifest });
}

function evaluateBuildModule(source: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: BUILD_EVALUATION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("build module output exceeds 2 MiB")); }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const marker = stdout.lastIndexOf(`\n${BUILD_ARTIFACT_MARKER}`);
      if (code !== 0 || marker < 0) {
        const reason = signal === "SIGKILL"
          ? "the schema module did not finish loading"
          : stderr.trim().split("\n").find((line) => /Error\b/.test(line))?.trim() ?? "the schema module could not be evaluated";
        reject(new Error(reason));
        return;
      }
      const start = marker + 1 + BUILD_ARTIFACT_MARKER.length;
      try {
        resolve(JSON.parse(stdout.slice(start, stdout.indexOf("\n", start))));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(source);
  });
}

async function writeSessionManifest(outdir: string, schemaPath: string, runtimeId: string, appName: string, configuration: AppDeploymentConfiguration): Promise<SessionRuntimeManifest> {
  const databaseSchema = await buildDatabaseSchema(schemaPath);
  const manifest: SessionRuntimeManifest = Object.freeze({
    schema_version: 1,
    kind: "cantelop-session-runtime",
    main_module: SESSION_RUNTIME_MAIN_MODULE,
    cli_build_protocol_version: CANTELOP_CLI_BUILD_PROTOCOL_VERSION,
    runtime_protocol_version: 2,
    integration_protocol_version: 2,
    session_runtime_id: runtimeId,
    app_name: appName,
    ...(configuration.environment === undefined ? {} : { environment: configuration.environment }),
    ...(configuration.dockerfile === undefined ? {} : { dockerfile: configuration.dockerfile }),
    capabilities: Object.freeze({ priority: false, messageCancellation: false, durableView: false }),
    ...(databaseSchema === undefined ? {} : { database_schema: databaseSchema }),
  });
  await writeFile(path.join(outdir, SESSION_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });
  return manifest;
}

/**
 * Bundles a Session runtime into one Bun-loadable module. Doing this at
 * deploy time removes node_modules graph discovery and TypeScript transforms
 * from the VM's request-critical startup path.
 */
export async function buildSessionRuntime(
  options: BuildSessionRuntimeOptions,
): Promise<SessionRuntimeArtifact> {
  const definitionPath = path.resolve(options.definition);
  let runtime = await readRuntimeDefinition(definitionPath, options.app);
  const entrypoint = runtime.entrypoint;
  const outdir = path.resolve(options.outdir);
  if (entrypoint === outdir || path.dirname(entrypoint) === outdir) {
    throw new TypeError(
      "Session runtime artifact output must not contain the source entrypoint",
    );
  }
  await mkdir(outdir, { recursive: true });

  const mainModule = path.join(outdir, SESSION_RUNTIME_MAIN_MODULE);
  await build(sessionRuntimeBuildOptions(definitionPath, mainModule, value => { runtime = value; }, options.app));
  const schemaPath = await projectSchemaPath(runtime.entrypoint, options.projectRoot);
  const manifest = await writeSessionManifest(outdir, schemaPath, runtime.definition.id, runtime.definition.name, runtime.definition);
  return Object.freeze({
    directory: outdir, mainModule,
    manifestFile: path.join(outdir, SESSION_MANIFEST_FILE), manifest,
  });
}

function sessionRuntimeBuildOptions(definitionPath: string, mainModule: string, onDefinition: (value: Awaited<ReturnType<typeof readRuntimeDefinition>>) => void, app?: string): BuildOptions {
  let watchFiles: readonly string[] = [definitionPath];
  let runtimeModule = "";
  return {
    entryPoints: ["cantelop:session-bootstrap"],
    plugins: [{ name: "cantelop-runtime-definition", setup(builder) {
      builder.onResolve({ filter: /^cantelop:extracted-runtime$/ }, () => ({ path: "runtime", namespace: "cantelop-extracted" }));
      builder.onLoad({ filter: /.*/, namespace: "cantelop-extracted" }, () => ({ contents: runtimeModule, loader: "js", resolveDir: path.dirname(definitionPath) }));
      builder.onResolve({ filter: /^cantelop:session-bootstrap$/ }, () => ({ path: "bootstrap", namespace: "cantelop-runtime" }));
      builder.onLoad({ filter: /.*/, namespace: "cantelop-runtime" }, async () => {
        try {
          const runtime = await readRuntimeDefinition(definitionPath, app);
          watchFiles = runtime.watchFiles;
          onDefinition(runtime);
          runtimeModule = runtime.runtimeModule;
          return {
            contents: sessionRuntimeBootstrap(),
            loader: "ts",
            resolveDir: path.dirname(runtime.entrypoint),
            watchFiles: [...watchFiles],
          };
        } catch (error) {
          if (error instanceof RuntimeContractError) watchFiles = [...new Set([...watchFiles, ...error.watchFiles])];
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }], watchFiles: [...watchFiles] };
        }
      });
    } }],
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

function sessionRuntimeBootstrap(): string {
  return [
    `const key = Symbol.for(${JSON.stringify(SESSION_RUNTIME_STARTUP_STATE_KEY)});`,
    "const state = { started: process.hrtime.bigint(), seen: new Set() };",
    "Object.defineProperty(globalThis, key, { value: state, configurable: false });",
    "const mark = (stage) => {",
    "  if (state.seen.has(stage)) return;",
    "  state.seen.add(stage);",
    "  const now = process.hrtime.bigint();",
    "  process.stderr.write(`${JSON.stringify({ component: \"cantelop.sdk\", event: \"session_runtime_startup_stage\", stage, elapsed_us: Number((now - state.started) / 1000n) })}\\n`);",
    "};",
    "mark(\"bun_entry\");",
    `const { serveSessionRuntime } = await import(${JSON.stringify(SESSION_RUNTIME_ADAPTER_MODULE)});`,
    'const { default: behaviour } = await import("cantelop:extracted-runtime");',
    'if (typeof behaviour.receive !== "function") throw new Error("Session runtime must export receive");',
    "mark(\"module_evaluated\");",
    "const sessionRuntime = serveSessionRuntime(behaviour);",
    "await sessionRuntime.ready;",
  ].join("\n");
}

export async function watchLocalProject(
  options: WatchLocalProjectOptions,
): Promise<LocalProjectWatcher> {
  const sessionDefinition = path.resolve(options.sessionDefinition);
  let runtime = await readRuntimeDefinition(sessionDefinition, options.app);
  let buildingRuntime = runtime;
  const sessionEntrypoint = runtime.entrypoint;
  const sessionRuntimeOutdir = path.resolve(options.sessionRuntimeOutdir);
  await mkdir(sessionRuntimeOutdir, { recursive: true });
  const schemaPath = await projectSchemaPath(sessionEntrypoint, options.projectRoot);
  const contexts: BuildContext[] = [];
  try {
    if (await exists(schemaPath)) {
      contexts.push(await watchedContext("database-schema", {
        entryPoints: [schemaPath], bundle: true, platform: "node", format: "esm", write: false,
        logLevel: "silent",
      }, options.onBuild, async () => writeSessionManifest(sessionRuntimeOutdir, schemaPath, runtime.definition.id, runtime.definition.name, runtime.definition)));
    }
    contexts.push(
      await watchedContext(
        "session-runtime",
        sessionRuntimeBuildOptions(
          sessionDefinition,
          path.join(sessionRuntimeOutdir, SESSION_RUNTIME_MAIN_MODULE),
          value => { buildingRuntime = value; },
          options.app,
        ),
        options.onBuild,
        async () => { runtime = buildingRuntime; return writeSessionManifest(sessionRuntimeOutdir, schemaPath, runtime.definition.id, runtime.definition.name, runtime.definition); },
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
  onBuild: (event: LocalBuildEvent) => void,
  finalize?: () => Promise<unknown>,
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
        if (error === "" && finalize !== undefined) {
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

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Discover the schema independently of any API module. */
async function projectSchemaPath(entrypoint: string, projectRoot?: string): Promise<string> {
  if (projectRoot !== undefined) return path.join(path.resolve(projectRoot), "db/schema.ts");
  for (let directory = path.dirname(path.resolve(entrypoint)); ; directory = path.dirname(directory)) {
    if (await exists(path.join(directory, "cantelop.json")) || await exists(path.join(directory, "package.json"))) return path.join(directory, "db/schema.ts");
    if (path.dirname(directory) === directory) return path.join(path.dirname(path.resolve(entrypoint)), "db/schema.ts");
  }
}
/** Discovered automatically from the project root; absence opts out of managed application schemas. */
export async function buildDatabaseSchema(entrypoint = path.resolve("db/schema.ts")): Promise<ApplicationDatabaseSchema | undefined> {
  if (!await exists(entrypoint)) return undefined;
  const bundle = await build({
    stdin: { contents: `import * as schema from ${JSON.stringify(path.resolve(entrypoint))};\nglobalThis.__cantelopBuildSchema = schema;`,
      resolveDir: path.dirname(path.resolve(entrypoint)), loader: "ts" },
    bundle: true, format: "esm", platform: "node", target: "es2022", write: false, logLevel: "silent",
  });
  const source = bundle.outputFiles?.[0]?.text;
  if (!source) throw new Error("database schema produced no module");
  const generator = fileURLToPath(new URL("./database-schema.js", import.meta.url));
  const result = await evaluateBuildModule(`${source}\nimport { createApplicationSchema } from ${JSON.stringify(generator)};\nconst artifact = await createApplicationSchema(globalThis.__cantelopBuildSchema);\nprocess.stdout.write("\\n${BUILD_ARTIFACT_MARKER}" + JSON.stringify(artifact) + "\\n", () => process.exit(0));`);
  const { validateApplicationSchema } = await import("./database-schema.js");
  return validateApplicationSchema(result);
}

/** Generate a backend client module with the Sandbox dependency graph removed. */
export async function buildBackendClient(options: { readonly definition: string; readonly outdir: string }) {
  const compiled = await compileAppDefinitions(path.resolve(options.definition));
  const directory = path.resolve(options.outdir);
  await mkdir(directory, { recursive: true });
  const mainModule = path.join(directory, "client.mjs");
  await build({ stdin: { contents: compiled.backendSource, resolveDir: path.dirname(path.resolve(options.definition)), loader: "ts" }, bundle: true, packages: "external", platform: "node", format: "esm", target: "es2022", outfile: mainModule, logLevel: "silent" });
  const manifest = { schema_version: 1, kind: "cantelop-backend-client", apps: compiled.apps.map(app => ({ name: app.definition.name, session_runtime_id: app.definition.id })), main_module: "client.mjs" } as const;
  const manifestFile = path.join(directory, "cantelop-client.json");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return { directory, mainModule, manifestFile, manifest };
}

/** Build each named App into its own deployment directory plus the shared backend module. */
export async function buildAppArtifacts(options: { readonly definition: string; readonly outdir: string; readonly projectRoot?: string }) {
  const compiled = await compileAppDefinitions(path.resolve(options.definition));
  const apps = [];
  for (const app of compiled.apps) {
    const outdir = path.join(path.resolve(options.outdir), app.definition.name);
    const edge = await buildEdgeApi({ definition: options.definition, app: app.definition.name, outdir: path.join(outdir, "edge") });
    const runtime = await buildSessionRuntime({ definition: options.definition, app: app.definition.name, outdir: path.join(outdir, "runtime"), ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }) });
    if (edge.manifest.session_runtime_id !== runtime.manifest.session_runtime_id) throw new Error("App definition changed during build; rebuild artifacts");
    apps.push({ name: app.definition.name, edge, runtime });
  }
  const backend = await buildBackendClient({ definition: options.definition, outdir: path.join(path.resolve(options.outdir), "backend") });
  for (const app of apps) if (backend.manifest.apps.find(record => record.name === app.name)?.session_runtime_id !== app.runtime.manifest.session_runtime_id) throw new Error("App definition changed during build; rebuild artifacts");
  return { apps, backend };
}
