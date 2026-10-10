import * as esbuild from "esbuild";

import { chmod, mkdir, readFile, rm } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import path from "node:path";

// Bundles the server into one platform-neutral file that runs with Node
// 22.19+ on Linux and macOS: dist/agentlink-server.js.

// Only loaded lazily by keychain-backed credential helpers, which the server
// does not use, plus optional native speedups that dependencies probe for.
const OPTIONAL_EXTERNALS = [
  "@napi-rs/keyring",
  "bufferutil",
  "utf-8-validate",
  "kerberos",
];
// Bare built-in specifiers some bundled dependencies use.
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

const root = path.dirname(fileURLToPath(import.meta.url));
// `--outfile <path>` builds elsewhere (tests build into a temp directory).
const outfileIndex = process.argv.indexOf("--outfile");
const customOutput =
  outfileIndex >= 0 ? process.argv[outfileIndex + 1] : undefined;
if (outfileIndex >= 0 && !customOutput) {
  throw new Error("--outfile needs a path");
}
const output = customOutput
  ? path.resolve(customOutput)
  : path.join(root, "dist", "agentlink-server.js");
if (!customOutput) {
  await rm(path.dirname(output), { recursive: true, force: true });
}
await mkdir(path.dirname(output), { recursive: true });

// The web app is the shared Ask Agent browser UI from the VS Code browser
// gateway, built here with the same options. It is embedded in the server
// bundle (the container image only receives this one file) and served from
// the same fixed paths as the gateway helper; see webAssets.ts. The page
// itself is rendered per request with its boot configuration.
const repoRoot = path.resolve(root, "..", "..");
const webOutdir = path.join(root, ".web-build");
const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
};
const BINARY_EXTENSIONS = new Set([".ttf", ".png"]);
const webviewOptions = {
  absWorkingDir: repoRoot,
  bundle: true,
  outdir: webOutdir,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  keepNames: true,
  minify: true,
  legalComments: "none",
  assetNames: "[name]",
  loader: { ".ttf": "file" },
  jsx: "automatic",
  jsxImportSource: "preact",
  define: { __DEV_BUILD__: "false" },
  write: false,
};
// Monaco (used read-only by the file viewer) is a separate bundle loaded on
// demand from /browser-gateway-monaco.js, as in the gateway; keep the import
// external to the app and build it, plus its workers, separately below.
const browserMonacoExternalPlugin = {
  name: "browser-monaco-external",
  setup(build) {
    build.onResolve({ filter: /^\.\/browserMonaco$/ }, (args) => {
      if (!args.importer.endsWith("browserMonacoLoader.ts")) return undefined;
      return { path: "/browser-gateway-monaco.js", external: true };
    });
  },
};
const MONACO_WORKERS = {
  "monaco-editor.worker": "editor/editor.worker.js",
  "monaco-json.worker": "languages/features/json/json.worker.js",
  "monaco-css.worker": "languages/features/css/css.worker.js",
  "monaco-html.worker": "languages/features/html/html.worker.js",
  "monaco-ts.worker": "languages/features/typescript/ts.worker.js",
};
const [gatewayApp, notificationsWorker, monaco, monacoWorkers] =
  await Promise.all([
    esbuild.build({
      ...webviewOptions,
      entryPoints: ["src/browser-gateway/webview/index.tsx"],
      entryNames: "browser-gateway",
      chunkNames: "browser-gateway-chunks/[name]-[hash]",
      splitting: true,
      plugins: [browserMonacoExternalPlugin],
    }),
    esbuild.build({
      ...webviewOptions,
      entryPoints: [
        "src/browser-gateway/webview/browserGatewayNotificationsWorker.ts",
      ],
      entryNames: "browser-gateway-notifications",
    }),
    esbuild.build({
      ...webviewOptions,
      entryPoints: ["src/browser-gateway/webview/components/browserMonaco.ts"],
      entryNames: "browser-gateway-monaco",
      // Monaco ships its own codicon font; keep it apart from the app's.
      assetNames: "browser-gateway-monaco-[name]",
    }),
    esbuild.build({
      ...webviewOptions,
      entryPoints: Object.fromEntries(
        Object.entries(MONACO_WORKERS).map(([name, file]) => [
          name,
          `node_modules/monaco-editor/esm/vs/${file}`,
        ]),
      ),
    }),
  ]);
const webAssets = {};
const addAsset = (urlPath, contents, options = {}) => {
  const extension = path.extname(urlPath);
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) throw new Error(`No content type for web asset ${urlPath}`);
  if (webAssets[urlPath]) throw new Error(`Duplicate web asset ${urlPath}`);
  const binary = BINARY_EXTENSIONS.has(extension);
  webAssets[urlPath] = {
    contentType,
    body: Buffer.from(contents).toString(binary ? "base64" : "utf8"),
    ...(binary ? { encoding: "base64" } : {}),
    ...(options.immutable ? { immutable: true } : {}),
  };
};
for (const file of [
  ...gatewayApp.outputFiles,
  ...notificationsWorker.outputFiles,
  ...monaco.outputFiles,
  ...monacoWorkers.outputFiles,
]) {
  const urlPath = `/${path.relative(webOutdir, file.path).split(path.sep).join("/")}`;
  addAsset(urlPath, file.contents, {
    immutable: urlPath.startsWith("/browser-gateway-chunks/"),
  });
}
const repoFile = (...segments) => readFile(path.join(repoRoot, ...segments));
addAsset(
  "/codicon.css",
  await repoFile("node_modules", "@vscode", "codicons", "dist", "codicon.css"),
);
addAsset(
  "/codicon.ttf",
  await repoFile("node_modules", "@vscode", "codicons", "dist", "codicon.ttf"),
);
const icon = await repoFile("media", "icon.png");
for (const iconPath of ["/agentlink-icon.png", "/apple-touch-icon.png"]) {
  addAsset(iconPath, icon);
}
webAssets["/favicon.ico"] = { ...webAssets["/agentlink-icon.png"] };
addAsset(
  "/agentlink-icon.svg",
  await repoFile("media", "agentlink-terminal.svg"),
);
webAssets["/site.webmanifest"] = {
  contentType: "application/manifest+json",
  body: JSON.stringify({
    name: "AgentLink Assistant",
    short_name: "AgentLink",
    description: "Your self-hosted AgentLink assistant.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#1e1e1e",
    theme_color: "#4EC9B0",
    icons: [
      {
        src: "/agentlink-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/agentlink-icon.png",
        sizes: "256x256",
        type: "image/png",
        purpose: "any",
      },
    ],
  }),
};
for (const required of [
  "/browser-gateway.js",
  "/browser-gateway.css",
  "/browser-gateway-notifications.js",
  "/browser-gateway-monaco.js",
  "/browser-gateway-monaco.css",
  ...Object.keys(MONACO_WORKERS).map((name) => `/${name}.js`),
]) {
  if (!webAssets[required]) throw new Error(`Web build is missing ${required}`);
}

const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  metafile: true,
  define: { __AGENTLINK_WEB_ASSETS__: JSON.stringify(webAssets) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __agentlinkCreateRequire } from "node:module";\nconst require = __agentlinkCreateRequire(import.meta.url);',
  },
  external: OPTIONAL_EXTERNALS,
});
await chmod(output, 0o755);

const outputMetadata = Object.entries(build.metafile.outputs).find(
  ([file]) => path.resolve(file) === output,
)?.[1];
if (!outputMetadata) throw new Error("Server bundle metadata is unavailable");
const unexpected = [
  ...new Set(
    outputMetadata.imports
      .filter((entry) => entry.external)
      .map((entry) => entry.path)
      .filter(
        (specifier) =>
          !specifier.startsWith("node:") &&
          !OPTIONAL_EXTERNALS.includes(specifier) &&
          !NODE_BUILTINS.has(specifier),
      ),
  ),
];
if (unexpected.length > 0) {
  throw new Error(
    `Unexpected server bundle external imports: ${unexpected.sort().join(", ")}`,
  );
}
