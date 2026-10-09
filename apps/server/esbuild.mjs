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

// The web app is embedded in the server bundle (the container image only
// receives this one file) and served from fixed paths; see webAssets.ts.
const webRoot = path.join(root, "web");
const webApp = await esbuild.build({
  entryPoints: [path.join(webRoot, "src", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "safari16", "chrome110", "firefox110"],
  minify: true,
  legalComments: "none",
  write: false,
});
const webFile = (name) => readFile(path.join(webRoot, name), "utf8");
const webAssets = {
  "/": {
    contentType: "text/html; charset=utf-8",
    body: await webFile("index.html"),
  },
  "/app.js": {
    contentType: "text/javascript; charset=utf-8",
    body: webApp.outputFiles[0].text,
  },
  "/app.css": {
    contentType: "text/css; charset=utf-8",
    body: await webFile("app.css"),
  },
  "/icon.svg": {
    contentType: "image/svg+xml",
    body: await webFile("icon.svg"),
  },
  "/manifest.webmanifest": {
    contentType: "application/manifest+json",
    body: await webFile("manifest.webmanifest"),
  },
};

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
