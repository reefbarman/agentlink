import * as esbuild from "esbuild";
import * as path from "path";

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import {
  createBrowserGatewayBundleReport,
  verifyBrowserGatewayBundlePackaging,
} from "./scripts/browser-gateway-bundle-report.mjs";

import { resolveBrowserGatewayDevBuild } from "./scripts/browser-gateway-build-env.mjs";
import { stageRetrievalRuntime } from "./scripts/package-retrieval-runtime.mjs";
import { stageSandboxRuntime } from "./scripts/package-sandbox-runtime.mjs";
import { workspacePackageClosurePlugin } from "./scripts/workspace-bundle-closure.mjs";

const watch = process.argv.includes("--watch");
const browserGatewayReportArgument = process.argv.find((argument) =>
  argument.startsWith("--browser-gateway-report="),
);
const browserGatewayReportPath =
  browserGatewayReportArgument?.slice("--browser-gateway-report=".length) ||
  "dist/browser-gateway-bundle-report.json";
const browserGatewayChunkDir = "dist/browser-gateway-chunks";
rmSync(browserGatewayChunkDir, { recursive: true, force: true });

// Load .env.local if it exists (for DEV_BUILD=true opt-in). An explicit
// environment value keeps builds deterministic in CI and isolated worktrees.
let envLocal;
try {
  envLocal = readFileSync(".env.local", "utf-8");
} catch {
  // No .env.local — dev tools disabled unless explicitly enabled.
}
const devBuild = resolveBrowserGatewayDevBuild(process.env.DEV_BUILD, envLocal);

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "@lancedb/lancedb", "apache-arrow"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  metafile: true,
  plugins: [workspacePackageClosurePlugin],
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
};

/** @type {esbuild.BuildOptions} */
const composeRuntimeOptions = {
  entryPoints: ["src/agent/compose/composeRuntime.ts"],
  bundle: true,
  outfile: "dist/compose-runtime.mjs",
  external: ["@lancedb/lancedb", "apache-arrow"],
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  metafile: true,
  plugins: [workspacePackageClosurePlugin],
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
  metafile: true,
  plugins: [workspacePackageClosurePlugin],
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

// Pop-out preview panel for mermaid/vega blocks. Must be a self-contained
// bundle: node_modules is not shipped in the .vsix, and vega-embed's dist
// uses bare import specifiers that a webview can't resolve.
/** @type {esbuild.BuildOptions} */
const specialBlockPanelOptions = {
  ...webviewBase,
  entryPoints: ["src/agent/webview/specialBlockPanel.ts"],
  entryNames: "special-block-panel",
};

/** @type {esbuild.BuildOptions} */
const browserMonacoExternalPlugin = {
  name: "browser-monaco-external",
  setup(build) {
    build.onResolve({ filter: /^\.\/browserMonaco$/ }, (args) => {
      if (!args.importer.endsWith("BrowserDiffViewer.tsx")) return undefined;
      return { path: "/browser-gateway-monaco.js", external: true };
    });
  },
};

const browserGatewayOptions = {
  ...webviewBase,
  entryPoints: ["src/browser-gateway/webview/index.tsx"],
  entryNames: "browser-gateway",
  chunkNames: "browser-gateway-chunks/[name]-[hash]",
  splitting: true,
  metafile: true,
  plugins: [browserMonacoExternalPlugin, workspacePackageClosurePlugin],
};

const browserGatewayMonacoOptions = {
  ...webviewBase,
  entryPoints: ["src/browser-gateway/webview/components/browserMonaco.ts"],
  entryNames: "browser-gateway-monaco",
  metafile: true,
};

const browserGatewayNotificationsWorkerOptions = {
  ...webviewBase,
  entryPoints: [
    "src/browser-gateway/webview/browserGatewayNotificationsWorker.ts",
  ],
  entryNames: "browser-gateway-notifications",
  metafile: true,
};

/** @type {esbuild.BuildOptions} */
const terminalOptions = {
  ...webviewBase,
  entryPoints: ["src/terminal/webview/index.tsx"],
  entryNames: "terminal",
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
  metafile: true,
  plugins: [workspacePackageClosurePlugin],
};

/** @type {esbuild.BuildOptions} */
const indexerOptions = {
  entryPoints: ["src/indexer/worker.ts"],
  bundle: true,
  outfile: "dist/indexer-worker.js",
  external: ["vscode", "@lancedb/lancedb", "apache-arrow"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  metafile: true,
  plugins: [workspacePackageClosurePlugin],
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
  external: ["vscode", "@lancedb/lancedb", "apache-arrow"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  metafile: true,
  plugins: [workspacePackageClosurePlugin],
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
};

const wasmDestDir = "dist/wasm";
mkdirSync(wasmDestDir, { recursive: true });
copyFileSync(
  "node_modules/@jitl/quickjs-wasmfile-release-asyncify/dist/emscripten-module.wasm",
  path.join(wasmDestDir, "quickjs-release-asyncify.wasm"),
);

if (watch) {
  const [
    extCtx,
    composeRuntimeCtx,
    sideCtx,
    appCtx,
    frCtx,
    chatCtx,
    specialBlockPanelCtx,
    browserGatewayCtx,
    browserGatewayMonacoCtx,
    browserGatewayNotificationsWorkerCtx,
    terminalCtx,
    monacoWorkerCtx,
    idxCtx,
    helperCtx,
  ] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(composeRuntimeOptions),
    esbuild.context(sidebarOptions),
    esbuild.context(approvalOptions),
    esbuild.context(frPreviewOptions),
    esbuild.context(chatOptions),
    esbuild.context(specialBlockPanelOptions),
    esbuild.context(browserGatewayOptions),
    esbuild.context(browserGatewayMonacoOptions),
    esbuild.context(browserGatewayNotificationsWorkerOptions),
    esbuild.context(terminalOptions),
    esbuild.context(monacoWorkerOptions),
    esbuild.context(indexerOptions),
    esbuild.context(browserGatewayHelperOptions),
  ]);
  await Promise.all([
    extCtx.watch(),
    composeRuntimeCtx.watch(),
    sideCtx.watch(),
    appCtx.watch(),
    frCtx.watch(),
    chatCtx.watch(),
    specialBlockPanelCtx.watch(),
    browserGatewayCtx.watch(),
    browserGatewayMonacoCtx.watch(),
    browserGatewayNotificationsWorkerCtx.watch(),
    terminalCtx.watch(),
    monacoWorkerCtx.watch(),
    idxCtx.watch(),
    helperCtx.watch(),
  ]);
  console.log("Watching for changes...");
} else {
  const browserGatewayBuild = esbuild.build(browserGatewayOptions);
  const browserGatewayMonacoBuild = esbuild.build(browserGatewayMonacoOptions);
  const browserGatewayNotificationsWorkerBuild = esbuild.build(
    browserGatewayNotificationsWorkerOptions,
  );
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(composeRuntimeOptions),
    esbuild.build(sidebarOptions),
    esbuild.build(approvalOptions),
    esbuild.build(frPreviewOptions),
    esbuild.build(chatOptions),
    esbuild.build(specialBlockPanelOptions),
    browserGatewayBuild,
    browserGatewayMonacoBuild,
    browserGatewayNotificationsWorkerBuild,
    esbuild.build(terminalOptions),
    esbuild.build(monacoWorkerOptions),
    esbuild.build(indexerOptions),
    esbuild.build(browserGatewayHelperOptions),
  ]);
  const [
    browserGatewayResult,
    browserGatewayMonacoResult,
    browserGatewayNotificationsWorkerResult,
  ] = await Promise.all([
    browserGatewayBuild,
    browserGatewayMonacoBuild,
    browserGatewayNotificationsWorkerBuild,
  ]);
  if (
    !browserGatewayResult.metafile ||
    !browserGatewayMonacoResult.metafile ||
    !browserGatewayNotificationsWorkerResult.metafile
  ) {
    throw new Error("browser_gateway_metafile_missing");
  }
  const browserGatewayBundleReport = createBrowserGatewayBundleReport({
    inputs: {
      ...browserGatewayResult.metafile.inputs,
      ...browserGatewayMonacoResult.metafile.inputs,
      ...browserGatewayNotificationsWorkerResult.metafile.inputs,
    },
    outputs: {
      ...browserGatewayResult.metafile.outputs,
      ...browserGatewayMonacoResult.metafile.outputs,
      ...browserGatewayNotificationsWorkerResult.metafile.outputs,
    },
  });
  verifyBrowserGatewayBundlePackaging(
    browserGatewayBundleReport,
    readFileSync(".vscodeignore", "utf-8"),
  );
  mkdirSync(path.dirname(browserGatewayReportPath), { recursive: true });
  writeFileSync(
    browserGatewayReportPath,
    `${JSON.stringify(browserGatewayBundleReport, null, 2)}\n`,
  );
  console.log(
    `Browser gateway bundle: ${browserGatewayBundleReport.totalBytes} bytes; report: ${browserGatewayReportPath}`,
  );
  // Copy the canonical shared codicon assets last. The browser Monaco bundle may
  // emit the same font path; both surfaces intentionally resolve this final file.
  copyFileSync(
    "node_modules/@vscode/codicons/dist/codicon.css",
    "dist/codicon.css",
  );
  copyFileSync(
    "node_modules/@vscode/codicons/dist/codicon.ttf",
    "dist/codicon.ttf",
  );
  // Copy tree-sitter WASM files to dist/wasm/
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

  const [sandboxRuntime, retrievalRuntime] = await Promise.all([
    stageSandboxRuntime(),
    stageRetrievalRuntime(),
  ]);
  console.log(
    `Retrieval runtime: ${retrievalRuntime.target} (${retrievalRuntime.nativePackage}); ${retrievalRuntime.packages.length} packages staged`,
  );
  console.log(
    `Sandbox runtime: ${sandboxRuntime.staged.length} entries staged`,
  );

  console.log("Build complete.");
}
