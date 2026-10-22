/// <reference types="node" />
/**
 * Build tooling for the Cantelop CLI and the platform.
 *
 * Application authors normally use `cantelop dev` and `cantelop deploy` and never call
 * these builders directly. The one export meant for application code is
 * `createCantelopCompilerPlugin`, which an App backend adds to its own esbuild pipeline
 * to strip Sandbox-only dependencies from the definition module. Everything else
 * (artifact builders, watch mode, database schema helpers, the auth terminal bridge)
 * is CLI-facing; its compatibility is governed by CANTELOP_CLI_BUILD_PROTOCOL_VERSION.
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  build,
  context as createBuildContext,
  type BuildContext,
  type BuildOptions,
  type BuildResult,
  type Plugin,
} from "esbuild";
import type { AppDeploymentConfiguration } from "./app-definition.js";
import { compileClientDefinition, compileAppDefinitions, RuntimeContractError } from "./compiler.js";
import { validateApplicationSchema, type ApplicationDatabaseSchema } from "./database-schema.js";
import { CANTELOP_FLEET_EXECUTION_PROTOCOL_VERSION, CANTELOP_INTEGRATION_PROTOCOL_VERSION } from "./integration-protocol.js";

export { createCantelopCompilerPlugin } from "./compiler.js";
export { bridgeAuthTerminal } from "./auth-terminal-bridge.js";
export type { AuthTerminalBridgeOptions } from "./auth-terminal-bridge.js";
export { createApplicationSchema, validateApplicationSchema, applicationMigrationSQL, synchronizeApplicationSchema, synchronizeLocalDatabase, DatabaseSchemaError } from "./database-schema.js";
export type { ApplicationDatabaseSchema, AppliedApplicationMigration } from "./database-schema.js";
export const CANTELOP_DATABASE_SCHEMA_PROTOCOL_VERSION = 1;

const BUILD_EVALUATION_TIMEOUT_MS = 10_000;
const BUILD_ARTIFACT_MARKER = "cantelop-build-artifact:";
const SESSION_RUNTIME_MAIN_MODULE = "session-runtime.mjs";
const SESSION_MANIFEST_FILE = "cantelop-runtime.json";
const SESSION_RUNTIME_ADAPTER_MODULE = fileURLToPath(new URL("./runtime.js", import.meta.url));
const SESSION_RUNTIME_STARTUP_STATE_KEY = "dev.cantelop.sdk.session-runtime-startup.v1";
const SCHEMA_GENERATOR_MODULE = fileURLToPath(new URL("./database-schema.js", import.meta.url));
const PROTOCOL_EDGE_MODULE = fileURLToPath(new URL("./protocol-edge.js", import.meta.url));
const MAX_BUILD_MODULE_OUTPUT = 2 * 1024 * 1024;
/** Sandbox actor protocol spoken by the bundled Session runtime. */
const SESSION_RUNTIME_PROTOCOL_VERSION = 2;

// The CLI checks this exact protocol before using the build module. Increment
// it when an incompatible build/watch contract is introduced.
export const CANTELOP_CLI_BUILD_PROTOCOL_VERSION = 7;

/** Local credentials and HTTP libSQL support required by database-enabled CLI dev. */
export const CANTELOP_LOCAL_DATABASE_PROTOCOL_VERSION = 1;

export interface BuildSessionRuntimeOptions {
  readonly definition: string;
  /** Selects one App by its `name`; required when the definition module exports several. Not a rename (see buildAppArtifacts' `appName`). */
  readonly app?: string;
  readonly outdir: string;
  /** Manifest/project root; inferred from the Session entrypoint when omitted. */
  readonly projectRoot?: string;
}

export interface SessionRuntimeManifest extends AppDeploymentConfiguration {
  readonly schema_version: 1;
  readonly kind: "cantelop-session-runtime";
  readonly main_module: "session-runtime.mjs";
  readonly cli_build_protocol_version: typeof CANTELOP_CLI_BUILD_PROTOCOL_VERSION;
  readonly runtime_protocol_version: typeof SESSION_RUNTIME_PROTOCOL_VERSION;
  readonly integration_protocol_version: typeof CANTELOP_INTEGRATION_PROTOCOL_VERSION;
  readonly session_runtime_id: string;
  readonly app_name: string;
  readonly definition_kind?: "fleet";
  /** Advertised only after coordinated actor scheduling, attribution and projection support. */
  readonly capabilities: Readonly<{ steering: true; messageCancellation: true; durableView: true; authTerminal?: true }>;
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
  /** Selects one App by its `name`; required when the definition module exports several. */
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
  /** Selects one App by its `name`; required when the definition module exports several. */
  readonly app?: string;
  readonly outdir: string;
  /** Local CLI only: a numeric loopback Session bridge origin. */
  readonly runtimeOrigin?: string;
}
export interface EdgeApiArtifact {
  readonly directory: string;
  readonly mainModule: string;
  readonly manifestFile: string;
  readonly manifest: Readonly<AppDeploymentConfiguration & {
    schema_version: 1;
    kind: "cantelop-protocol-edge";
    main_module: "worker.mjs";
    cli_build_protocol_version: typeof CANTELOP_CLI_BUILD_PROTOCOL_VERSION;
    integration_protocol_version: typeof CANTELOP_INTEGRATION_PROTOCOL_VERSION;
    fleet_execution_protocol_version: typeof CANTELOP_FLEET_EXECUTION_PROTOCOL_VERSION;
    session_runtime_id: string;
    app_name: string;
    definition_kind?: "fleet";
    required_bindings: readonly ["CANTELOP_INTEGRATION_TOKEN"];
    /** The Worker also accepts a rotated-out token until the paired expiry passes. */
    /** Fleet installations also set `CANTELOP_FLEET_EXECUTION_VERSION`, requiring `props.CANTELOP_RUNTIME` on every request. */
    optional_bindings: readonly ["CANTELOP_INTEGRATION_TOKEN_PREVIOUS", "CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT", "CANTELOP_FLEET_EXECUTION_VERSION"];
    default_keep_alive_binding: "CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS";
    webhooks: readonly { readonly path: string; readonly method: "GET" | "POST" }[];
    homepage: boolean;
    /** The App declares auth: the platform must route auth terminal upgrades to the auth Sandbox. */
    auth?: true;
  }>;
}

/** Generates the protocol-owned App Worker; there is no customer API entrypoint. */
export async function buildEdgeApi(options: BuildEdgeApiOptions): Promise<EdgeApiArtifact> {
  return writeEdgeApi(await compileClientDefinition(path.resolve(options.definition), options.app), options);
}

type CompiledApp = Awaited<ReturnType<typeof compileClientDefinition>>;

async function writeEdgeApi(runtime: CompiledApp, options: BuildEdgeApiOptions): Promise<EdgeApiArtifact> {
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
  const workerOptions = {
    runtimeId: runtime.definition.id,
    appName: runtime.definition.name,
    environment: runtime.definition.environment ?? {},
    ...(runtime.definition.auth ? { auth: true } : {}),
    ...(options.runtimeOrigin === undefined ? {} : { runtimeOrigin: options.runtimeOrigin }),
  };
  await build({
    stdin: { contents: `import { createProtocolWorker } from ${JSON.stringify(PROTOCOL_EDGE_MODULE)};\nimport ingress from "cantelop:webhooks";\nexport default createProtocolWorker({ ...${JSON.stringify(workerOptions)}, ...ingress });`, resolveDir: outdir },
    bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: mainModule, logLevel: "silent",
    plugins: [{ name: "cantelop-webhook-artifact", setup(builder) {
      builder.onResolve({ filter: /^cantelop:webhooks$/ }, () => ({ path: "webhooks", namespace: "cantelop" }));
      builder.onLoad({ filter: /.*/, namespace: "cantelop" }, () => ({ contents: runtime.webhookModule, loader: "js" }));
    } }],
  });
  const manifest: EdgeApiArtifact["manifest"] = Object.freeze({
    schema_version: 1, kind: "cantelop-protocol-edge", main_module: "worker.mjs", fleet_execution_protocol_version: CANTELOP_FLEET_EXECUTION_PROTOCOL_VERSION,
    cli_build_protocol_version: CANTELOP_CLI_BUILD_PROTOCOL_VERSION, integration_protocol_version: CANTELOP_INTEGRATION_PROTOCOL_VERSION, session_runtime_id: runtime.definition.id, app_name: runtime.definition.name,
    ...(runtime.definition.definitionKind === undefined ? {} : { definition_kind: runtime.definition.definitionKind }),
    ...(runtime.definition.environment === undefined ? {} : { environment: runtime.definition.environment }),
    ...(runtime.definition.dockerfile === undefined ? {} : { dockerfile: runtime.definition.dockerfile }),
    required_bindings: Object.freeze(["CANTELOP_INTEGRATION_TOKEN"] as const),
    optional_bindings: Object.freeze(["CANTELOP_INTEGRATION_TOKEN_PREVIOUS", "CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT", "CANTELOP_FLEET_EXECUTION_VERSION"] as const),
    default_keep_alive_binding: "CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS",
    webhooks: Object.freeze(runtime.webhookRoutes.map(route => Object.freeze({ ...route }))),
    homepage: runtime.hasHomepage,
    ...(runtime.definition.auth ? { auth: true } : {}),
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
      if (stdout.length > MAX_BUILD_MODULE_OUTPUT) { child.kill("SIGKILL"); reject(new Error("build module output exceeds 2 MiB")); }
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

/** The schema is built by the caller (once per build or schema change) and shared by every App manifest. */
async function writeSessionManifest(outdir: string, databaseSchema: ApplicationDatabaseSchema | undefined, definition: CompiledApp["definition"]): Promise<SessionRuntimeManifest> {
  const manifest: SessionRuntimeManifest = Object.freeze({
    schema_version: 1,
    kind: "cantelop-session-runtime",
    main_module: SESSION_RUNTIME_MAIN_MODULE,
    cli_build_protocol_version: CANTELOP_CLI_BUILD_PROTOCOL_VERSION,
    runtime_protocol_version: SESSION_RUNTIME_PROTOCOL_VERSION,
    integration_protocol_version: CANTELOP_INTEGRATION_PROTOCOL_VERSION,
    session_runtime_id: definition.id,
    app_name: definition.name,
    ...(definition.definitionKind === undefined ? {} : { definition_kind: definition.definitionKind }),
    ...(definition.environment === undefined ? {} : { environment: definition.environment }),
    ...(definition.dockerfile === undefined ? {} : { dockerfile: definition.dockerfile }),
    capabilities: Object.freeze({ steering: true, messageCancellation: true, durableView: true, ...(definition.auth ? { authTerminal: true } : {}) }),
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
  const compiled = await compileClientDefinition(definitionPath, options.app, { webhooks: false });
  const databaseSchema = await buildDatabaseSchema(await projectSchemaPath(compiled.entrypoint, options.projectRoot));
  return writeSessionRuntime(compiled, definitionPath, options, databaseSchema);
}

async function writeSessionRuntime(compiled: CompiledApp, definitionPath: string, options: BuildSessionRuntimeOptions, databaseSchema: ApplicationDatabaseSchema | undefined): Promise<SessionRuntimeArtifact> {
  const entrypoint = compiled.entrypoint;
  const outdir = path.resolve(options.outdir);
  if (entrypoint === outdir || path.dirname(entrypoint) === outdir) {
    throw new TypeError(
      "Session runtime artifact output must not contain the source entrypoint",
    );
  }
  await mkdir(outdir, { recursive: true });

  const mainModule = path.join(outdir, SESSION_RUNTIME_MAIN_MODULE);
  // One-shot builds reuse the definition compiled by the caller instead of recompiling in onLoad.
  await build(sessionRuntimeBuildOptions(definitionPath, mainModule, () => {}, async () => compiled));
  const manifest = await writeSessionManifest(outdir, databaseSchema, compiled.definition);
  return Object.freeze({
    directory: outdir, mainModule,
    manifestFile: path.join(outdir, SESSION_MANIFEST_FILE), manifest,
  });
}

function sessionRuntimeBuildOptions(definitionPath: string, mainModule: string, onDefinition: (value: CompiledApp) => void, compile: () => Promise<CompiledApp>): BuildOptions {
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
          const runtime = await compile();
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
    'const { default: behaviour, auth } = await import("cantelop:extracted-runtime");',
    'if (typeof behaviour.receive !== "function" && typeof behaviour.create !== "function") throw new Error("Session runtime must export create or receive");',
    "mark(\"module_evaluated\");",
    "const sessionRuntime = serveSessionRuntime(behaviour, auth === undefined ? {} : { auth });",
    "await sessionRuntime.ready;",
  ].join("\n");
}

export async function watchLocalProject(
  options: WatchLocalProjectOptions,
): Promise<LocalProjectWatcher> {
  const sessionDefinition = path.resolve(options.sessionDefinition);
  const compile = () => compileClientDefinition(sessionDefinition, options.app, { webhooks: false });
  let runtime = await compile();
  let buildingRuntime = runtime;
  // The session-runtime context's first load reuses this definition; later loads recompile.
  let initialDefinition: Promise<CompiledApp> | undefined = Promise.resolve(runtime);
  const loadDefinition = () => { const pending = initialDefinition ?? compile(); initialDefinition = undefined; return pending; };
  const sessionRuntimeOutdir = path.resolve(options.sessionRuntimeOutdir);
  await mkdir(sessionRuntimeOutdir, { recursive: true });
  const schemaPath = await projectSchemaPath(runtime.entrypoint, options.projectRoot);
  const schemaWatched = await exists(schemaPath);
  // Evaluated once per schema change; runtime rebuilds reuse the last valid schema.
  let databaseSchema: ApplicationDatabaseSchema | undefined;
  const writeManifest = () => writeSessionManifest(sessionRuntimeOutdir, databaseSchema, runtime.definition);
  const contexts: BuildContext[] = [];
  try {
    if (schemaWatched) {
      contexts.push(await watchedContext("database-schema", schemaBundleOptions(schemaPath), options.onBuild, async result => {
        databaseSchema = await evaluateSchemaBundle(result.outputFiles?.[0]?.text);
        await writeManifest();
      }));
    }
    contexts.push(
      await watchedContext(
        "session-runtime",
        sessionRuntimeBuildOptions(
          sessionDefinition,
          path.join(sessionRuntimeOutdir, SESSION_RUNTIME_MAIN_MODULE),
          value => { buildingRuntime = value; },
          loadDefinition,
        ),
        options.onBuild,
        async () => {
          runtime = buildingRuntime;
          // Without a watched schema, a schema created later is picked up on the next runtime build.
          if (!schemaWatched) databaseSchema = await buildDatabaseSchema(schemaPath);
          return writeManifest();
        },
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
  finalize?: (result: BuildResult) => Promise<unknown>,
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
            await finalize(result);
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
/** Bundles the developer schema module so its exports can be evaluated outside this process. */
function schemaBundleOptions(entrypoint: string): BuildOptions {
  const resolved = path.resolve(entrypoint);
  return {
    stdin: { contents: `import * as schema from ${JSON.stringify(resolved)};\nglobalThis.__cantelopBuildSchema = schema;`, resolveDir: path.dirname(resolved), loader: "ts" },
    bundle: true, format: "esm", platform: "node", target: "es2022", write: false, logLevel: "silent",
  };
}

/** Evaluates a bundled schema module in a child process and validates the resulting artifact. */
async function evaluateSchemaBundle(source: string | undefined): Promise<ApplicationDatabaseSchema> {
  if (!source) throw new Error("database schema produced no module");
  const result = await evaluateBuildModule(`${source}\nimport { createApplicationSchema } from ${JSON.stringify(SCHEMA_GENERATOR_MODULE)};\nconst artifact = await createApplicationSchema(globalThis.__cantelopBuildSchema);\nprocess.stdout.write("\\n${BUILD_ARTIFACT_MARKER}" + JSON.stringify(artifact) + "\\n", () => process.exit(0));`);
  return validateApplicationSchema(result);
}

/** Discovered automatically from the project root; absence opts out of managed application schemas. */
export async function buildDatabaseSchema(entrypoint = path.resolve("db/schema.ts")): Promise<ApplicationDatabaseSchema | undefined> {
  if (!await exists(entrypoint)) return undefined;
  const bundle = await build(schemaBundleOptions(entrypoint));
  return evaluateSchemaBundle(bundle.outputFiles?.[0]?.text);
}

/** Generate a backend client module with the Sandbox dependency graph removed. */
export async function buildBackendClient(options: {
  readonly definition: string;
  readonly outdir: string;
  /** Override the literal deployment name of a single App without rewriting its source. */
  readonly appName?: string;
}) {
  return writeBackendClient(await compileAppDefinitions(path.resolve(options.definition), { webhooks: false, ...(options.appName === undefined ? {} : { appName: options.appName }) }), options);
}

async function writeBackendClient(compiled: Awaited<ReturnType<typeof compileAppDefinitions>>, options: { readonly definition: string; readonly outdir: string }) {
  const directory = path.resolve(options.outdir);
  await mkdir(directory, { recursive: true });
  const mainModule = path.join(directory, "client.mjs");
  await build({ stdin: { contents: compiled.backendSource, resolveDir: path.dirname(path.resolve(options.definition)), loader: "ts" }, bundle: true, packages: "external", platform: "node", format: "esm", target: "es2022", outfile: mainModule, logLevel: "silent" });
  const declarationFile = path.join(directory, "client.d.mts");
  for (const [relative, source] of compiled.emitBackendDeclarations()) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  const manifest = { schema_version: 1, kind: "cantelop-backend-client", apps: compiled.apps.map(app => ({ name: app.definition.name, session_runtime_id: app.definition.id, ...(app.definition.definitionKind === undefined ? {} : { definition_kind: app.definition.definitionKind }) })), main_module: "client.mjs" } as const;
  const manifestFile = path.join(directory, "cantelop-client.json");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return { directory, mainModule, declarationFile, manifestFile, manifest };
}

/** Build each named App into its own deployment directory plus the shared backend module. */
export async function buildAppArtifacts(options: {
  readonly definition: string;
  readonly outdir: string;
  readonly projectRoot?: string;
  /** Override the literal deployment name of a single App without rewriting its source. */
  readonly appName?: string;
  /** Local CLI only: a numeric loopback Session bridge origin. */
  readonly runtimeOrigin?: string;
}) {
  // Compile once so every artifact shares one consistent App identity.
  const definitionPath = path.resolve(options.definition);
  const compiled = await compileAppDefinitions(definitionPath, options.appName === undefined ? {} : { appName: options.appName });
  // Every App shares the definition's project, so the schema is built once for all of them.
  const databaseSchema = await buildDatabaseSchema(await projectSchemaPath(definitionPath, options.projectRoot));
  const apps = [];
  for (const app of compiled.apps) {
    const outdir = path.join(path.resolve(options.outdir), app.definition.name);
    const runtimeDefinition = { ...app, backendSource: compiled.backendSource, watchFiles: compiled.watchFiles };
    const edge = await writeEdgeApi(runtimeDefinition, { definition: options.definition, app: app.definition.name, outdir: path.join(outdir, "edge"), ...(options.runtimeOrigin === undefined ? {} : { runtimeOrigin: options.runtimeOrigin }) });
    const runtime = await writeSessionRuntime(runtimeDefinition, definitionPath, { definition: options.definition, app: app.definition.name, outdir: path.join(outdir, "runtime") }, databaseSchema);
    apps.push({ name: app.definition.name, edge, runtime });
  }
  const backend = await writeBackendClient(compiled, { definition: options.definition, outdir: path.join(path.resolve(options.outdir), "backend") });
  // The definition graph includes ingress, runtime and type dependencies.
  // Automatically discovered Workspace schemas are watched independently.
  return { apps, backend, watchFiles: [...new Set(compiled.watchFiles)] };
}
