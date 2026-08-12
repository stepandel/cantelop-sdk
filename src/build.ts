/// <reference types="node" />

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const MANIFEST_SCHEMA_VERSION = 1;
const EXECUTION_PROTOCOL_VERSION = 1;
const MAIN_MODULE = "worker.mjs";
const MANIFEST_FILE = "cantelop-api.json";
const EDGE_ADAPTER_MODULE = fileURLToPath(new URL("./edge.js", import.meta.url));

export interface BuildApiOptions {
  readonly entrypoint: string;
  readonly outdir: string;
}

export interface ApiArtifactManifest {
  readonly schema_version: 1;
  readonly kind: "cantelop-edge-api";
  readonly main_module: "worker.mjs";
  readonly execution_protocol_version: 1;
}

export interface ApiArtifact {
  readonly directory: string;
  readonly mainModule: string;
  readonly manifestFile: string;
  readonly manifest: ApiArtifactManifest;
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
