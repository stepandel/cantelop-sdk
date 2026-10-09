/// <reference types="node" />

/**
 * Build tooling reserved for the Cantelop CLI, not a supported application API.
 * Application authors should use `cantelop dev` and `cantelop deploy`.
 * Compatibility is governed by CANTELOP_CLI_BUILD_PROTOCOL_VERSION.
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { access, mkdir, writeFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertSessionRuntime } from "./session-runtime-definition.js";
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
  readonly outdir: string;
  /** Manifest/project root; inferred from the Session entrypoint when omitted. */
  readonly projectRoot?: string;
}

export interface SessionRuntimeManifest {
  readonly schema_version: 1;
  readonly kind: "cantelop-session-runtime";
  readonly main_module: "session-runtime.mjs";
  readonly cli_build_protocol_version: 6;
  readonly runtime_protocol_version: 2;
  readonly integration_protocol_version: 2;
  readonly session_runtime_id: string;
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
  readonly sessionRuntimeOutdir: string;
  readonly projectRoot?: string;
  readonly onBuild: (event: LocalBuildEvent) => void;
}

export interface LocalProjectWatcher {
  dispose(): Promise<void>;
}

export interface BuildEdgeApiOptions {
  readonly definition: string;
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
  const runtime = await readRuntimeDefinition(path.resolve(options.definition));
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
    cli_build_protocol_version: 6, integration_protocol_version: 2, session_runtime_id: runtime.definition.id,
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

async function writeSessionManifest(outdir: string, schemaPath: string, runtimeId: string): Promise<SessionRuntimeManifest> {
  const databaseSchema = await buildDatabaseSchema(schemaPath);
  const manifest: SessionRuntimeManifest = Object.freeze({
    schema_version: 1,
    kind: "cantelop-session-runtime",
    main_module: SESSION_RUNTIME_MAIN_MODULE,
    cli_build_protocol_version: CANTELOP_CLI_BUILD_PROTOCOL_VERSION,
    runtime_protocol_version: 2,
    integration_protocol_version: 2,
    session_runtime_id: runtimeId,
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
  let runtime = await readRuntimeDefinition(definitionPath);
  const entrypoint = runtime.entrypoint;
  const outdir = path.resolve(options.outdir);
  if (entrypoint === outdir || path.dirname(entrypoint) === outdir) {
    throw new TypeError(
      "Session runtime artifact output must not contain the source entrypoint",
    );
  }
  await mkdir(outdir, { recursive: true });

  const mainModule = path.join(outdir, SESSION_RUNTIME_MAIN_MODULE);
  await build(sessionRuntimeBuildOptions(definitionPath, mainModule, value => { runtime = value; }));
  const schemaPath = await projectSchemaPath(runtime.entrypoint, options.projectRoot);
  const manifest = await writeSessionManifest(outdir, schemaPath, runtime.definition.id);
  return Object.freeze({
    directory: outdir, mainModule,
    manifestFile: path.join(outdir, SESSION_MANIFEST_FILE), manifest,
  });
}

async function readRuntimeDefinition(filename: string) {
  const result = await build({
    stdin: { contents: `import definition from ${JSON.stringify(filename)}; globalThis.__cantelopRuntimeDefinition = definition;`, resolveDir: path.dirname(filename) },
    bundle: true, platform: "node", format: "esm", target: "es2022", write: false, metafile: true, logLevel: "silent",
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error("Runtime definition produced no module");
  const value = await evaluateBuildModule(`${source}\nprocess.stdout.write("\\n${BUILD_ARTIFACT_MARKER}" + JSON.stringify(globalThis.__cantelopRuntimeDefinition) + "\\n", () => process.exit(0));`);
  assertSessionRuntime(value);
  const entrypoint = await realpath(path.resolve(path.dirname(filename), value.entrypoint));
  const root = path.dirname(await realpath(filename));
  if (!(await stat(entrypoint)).isFile()) throw new TypeError("Runtime behaviour must be a regular file");
  const relative = path.relative(root, entrypoint);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new TypeError("Runtime behaviour must stay inside its definition directory");
  const inputs = await Promise.all(Object.keys(result.metafile?.inputs ?? {}).filter(input => input !== "<stdin>").map(input => realpath(path.resolve(input))));
  if (inputs.includes(entrypoint)) throw new TypeError("Runtime definitions must not import executable behaviour code");
  return { definition: value, entrypoint, watchFiles: inputs };
}

function sessionRuntimeBuildOptions(definitionPath: string, mainModule: string, onDefinition: (value: Awaited<ReturnType<typeof readRuntimeDefinition>>) => void): BuildOptions {
  return {
    entryPoints: ["cantelop:session-bootstrap"],
    plugins: [{ name: "cantelop-runtime-definition", setup(builder) {
      builder.onResolve({ filter: /^cantelop:session-bootstrap$/ }, () => ({ path: "bootstrap", namespace: "cantelop-runtime" }));
      builder.onLoad({ filter: /.*/, namespace: "cantelop-runtime" }, async () => {
        const runtime = await readRuntimeDefinition(definitionPath);
        onDefinition(runtime);
        const entrypoint = runtime.entrypoint;
        return {
          contents: sessionRuntimeBootstrap(entrypoint, runtime.definition.id),
          loader: "ts",
          resolveDir: path.dirname(entrypoint),
          watchFiles: runtime.watchFiles,
        };
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

function sessionRuntimeBootstrap(entrypoint: string, runtimeId: string): string {
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
    `const { default: definition } = await import(${JSON.stringify(entrypoint)});`,
    `if (definition?.sessionRuntime?.id !== ${JSON.stringify(runtimeId)} || typeof definition.receive !== "function") throw new Error("Session behaviour does not match its runtime definition");`,
    "mark(\"module_evaluated\");",
    "const sessionRuntime = serveSessionRuntime(definition);",
    "await sessionRuntime.ready;",
  ].join("\n");
}

export async function watchLocalProject(
  options: WatchLocalProjectOptions,
): Promise<LocalProjectWatcher> {
  const sessionDefinition = path.resolve(options.sessionDefinition);
  let runtime = await readRuntimeDefinition(sessionDefinition);
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
      }, options.onBuild, async () => writeSessionManifest(sessionRuntimeOutdir, schemaPath, runtime.definition.id)));
    }
    contexts.push(
      await watchedContext(
        "session-runtime",
        sessionRuntimeBuildOptions(
          sessionDefinition,
          path.join(sessionRuntimeOutdir, SESSION_RUNTIME_MAIN_MODULE),
          value => { buildingRuntime = value; },
        ),
        options.onBuild,
        async () => { runtime = buildingRuntime; return writeSessionManifest(sessionRuntimeOutdir, schemaPath, runtime.definition.id); },
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
