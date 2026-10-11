import { build } from "esbuild";
import { createCantelopCompilerPlugin } from "@cantelop/sdk/build";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["src/backend.ts"],
  outfile: "dist/backend.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "es2022",
  plugins: [createCantelopCompilerPlugin({ definition: root + "src/cantelop.ts" })],
});
