import * as esbuild from "esbuild";
import * as path from "path";

import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "fs";

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
  keepNames: true,
  minify: true,
  assetNames: "[name]",
  loader: {
    ".ttf": "file",
  },
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

/** @type {esbuild.BuildOptions} */
const chatOptions = {
  ...webviewBase,
  entryPoints: ["src/agent/webview/index.tsx"],
  entryNames: "chat",
};

/** @type {esbuild.BuildOptions} */
const browserGatewayOptions = {
  ...webviewBase,
  entryPoints: ["src/browser-gateway/webview/index.tsx"],
  entryNames: "browser-gateway",
};

// ⚠️ Every output file produced here must also be re-included in `.vscodeignore`
// (it uses an ignore-all + allowlist model). A new bundle output that isn't listed
// there builds fine locally but is dropped from the packaged .vsix and 404s for
// installed users. See the header comment in `.vscodeignore`.
/** @type {esbuild.BuildOptions} */
const monacoWorkerOptions = {
  entryPoints: {
    "monaco-editor.worker":
      "node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
    "monaco-json.worker":
      "node_modules/monaco-editor/esm/vs/language/json/json.worker.js",
    "monaco-css.worker":
      "node_modules/monaco-editor/esm/vs/language/css/css.worker.js",
    "monaco-html.worker":
      "node_modules/monaco-editor/esm/vs/language/html/html.worker.js",
    "monaco-ts.worker":
      "node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js",
  },
  bundle: true,
  outdir: "dist",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: true,
};

/** @type {esbuild.BuildOptions} */
const indexerOptions = {
  entryPoints: ["src/indexer/worker.ts"],
  bundle: true,
  outfile: "dist/indexer-worker.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
  // Force web-tree-sitter to resolve its CJS entry (uses __filename/__dirname)
  // instead of the ESM entry (uses import.meta.url which is undefined in CJS bundles)
  alias: {
    "web-tree-sitter": path.resolve(
      "node_modules/web-tree-sitter/web-tree-sitter.cjs",
    ),
  },
};

/** @type {esbuild.BuildOptions} */
const browserGatewayHelperOptions = {
  entryPoints: ["src/browser-gateway/helper/browserGatewayHelper.ts"],
  bundle: true,
  outfile: "dist/browser-gateway-helper.js",
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

if (watch) {
  const [
    extCtx,
    sideCtx,
    appCtx,
    frCtx,
    chatCtx,
    browserGatewayCtx,
    monacoWorkerCtx,
    idxCtx,
    helperCtx,
  ] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(sidebarOptions),
    esbuild.context(approvalOptions),
    esbuild.context(frPreviewOptions),
    esbuild.context(chatOptions),
    esbuild.context(browserGatewayOptions),
    esbuild.context(monacoWorkerOptions),
    esbuild.context(indexerOptions),
    esbuild.context(browserGatewayHelperOptions),
  ]);
  await Promise.all([
    extCtx.watch(),
    sideCtx.watch(),
    appCtx.watch(),
    frCtx.watch(),
    chatCtx.watch(),
    browserGatewayCtx.watch(),
    monacoWorkerCtx.watch(),
    idxCtx.watch(),
    helperCtx.watch(),
  ]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(sidebarOptions),
    esbuild.build(approvalOptions),
    esbuild.build(frPreviewOptions),
    esbuild.build(chatOptions),
    esbuild.build(browserGatewayOptions),
    esbuild.build(monacoWorkerOptions),
    esbuild.build(indexerOptions),
    esbuild.build(browserGatewayHelperOptions),
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
  // Copy tree-sitter WASM files to dist/wasm/
  const wasmDestDir = "dist/wasm";
  mkdirSync(wasmDestDir, { recursive: true });
  // Core parser WASM
  copyFileSync(
    "node_modules/web-tree-sitter/web-tree-sitter.wasm",
    path.join(wasmDestDir, "web-tree-sitter.wasm"),
  );
  // Language grammar WASMs from @vscode/tree-sitter-wasm
  const wasmSrcDir = "node_modules/@vscode/tree-sitter-wasm/wasm";
  for (const f of readdirSync(wasmSrcDir)) {
    if (f.endsWith(".wasm") && f.startsWith("tree-sitter-")) {
      copyFileSync(path.join(wasmSrcDir, f), path.join(wasmDestDir, f));
    }
  }

  console.log("Build complete.");
}
