import * as esbuild from "esbuild";
import * as path from "node:path";

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";

import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(root, "../..");
const hostVersion = JSON.parse(
  readFileSync(path.join(workspaceRoot, "package.json"), "utf-8"),
).version;
const outdir = path.join(root, "dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, "src/main.ts")],
    outfile: path.join(outdir, "main.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
    define: {
      __AGENTLINK_HOST_VERSION__: JSON.stringify(hostVersion),
    },
    external: ["electron", "@napi-rs/keyring"],
  }),
  esbuild.build({
    entryPoints: [path.join(root, "src/preload.ts")],
    outfile: path.join(outdir, "preload.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
    external: ["electron"],
  }),
  esbuild.build({
    entryPoints: [path.join(root, "src/chatPreload.ts")],
    outfile: path.join(outdir, "chat-preload.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
    external: ["electron"],
  }),
  esbuild.build({
    entryPoints: [path.join(root, "src/setup.ts")],
    outfile: path.join(outdir, "setup.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
  }),
]);

for (const asset of ["setup.html", "setup.css"]) {
  copyFileSync(path.join(root, "src", asset), path.join(outdir, asset));
}
