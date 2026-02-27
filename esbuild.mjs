import * as esbuild from "esbuild";
import { copyFileSync, readFileSync } from "fs";

const watch = process.argv.includes("--watch");

// Load .env.local if it exists (for DEV_BUILD=true opt-in)
let devBuild = false;
try {
  const envLocal = readFileSync(".env.local", "utf-8");
  devBuild = /^DEV_BUILD\s*=\s*true$/m.test(envLocal);
} catch {
  // No .env.local — dev tools disabled (default)
}

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
};

/** @type {esbuild.BuildOptions} */
const webviewBase = {
  bundle: true,
  outdir: "dist",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
};

/** @type {esbuild.BuildOptions} */
const sidebarOptions = {
  ...webviewBase,
  entryPoints: ["src/sidebar/webview/index.tsx"],
  entryNames: "sidebar",
};

/** @type {esbuild.BuildOptions} */
const approvalOptions = {
  ...webviewBase,
  entryPoints: ["src/approvals/webview/index.tsx"],
  entryNames: "approval",
};

/** @type {esbuild.BuildOptions} */
const frPreviewOptions = {
  ...webviewBase,
  entryPoints: ["src/findReplace/webview/index.tsx"],
  entryNames: "fr-preview",
};

if (watch) {
  const [extCtx, sideCtx, appCtx, frCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(sidebarOptions),
    esbuild.context(approvalOptions),
    esbuild.context(frPreviewOptions),
  ]);
  await Promise.all([extCtx.watch(), sideCtx.watch(), appCtx.watch(), frCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(sidebarOptions),
    esbuild.build(approvalOptions),
    esbuild.build(frPreviewOptions),
  ]);
  // Copy codicon assets to dist
  copyFileSync(
    "node_modules/@vscode/codicons/dist/codicon.css",
    "dist/codicon.css",
  );
  copyFileSync(
    "node_modules/@vscode/codicons/dist/codicon.ttf",
    "dist/codicon.ttf",
  );
  console.log("Build complete.");
}
