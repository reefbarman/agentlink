import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXPECTED_FILES = [
  "package/LICENSE",
  "package/README.md",
  "package/THIRD_PARTY_NOTICES.md",
  "package/dist/agentlink.js",
  "package/dist/rg",
  "package/dist/runtime-manifest.json",
  "package/package.json",
];
const EXPECTED_RUNTIME_DEPENDENCIES = { "@napi-rs/keyring": "2.0.0" };
const EXPECTED_EXTERNAL_IMPORTS = ["@napi-rs/keyring"];
export const EXPECTED_BUNDLED_DEPENDENCIES = {
  "@alcalzone/ansi-tokenize": "0.3.0",
  "@borewit/text-codec": "0.2.2",
  "@jimp/core": "1.6.1",
  "@jimp/diff": "1.6.1",
  "@jimp/file-ops": "1.6.1",
  "@jimp/js-bmp": "1.6.1",
  "@jimp/js-gif": "1.6.1",
  "@jimp/js-jpeg": "1.6.1",
  "@jimp/js-png": "1.6.1",
  "@jimp/js-tiff": "1.6.1",
  "@jimp/plugin-blit": "1.6.1",
  "@jimp/plugin-blur": "1.6.1",
  "@jimp/plugin-circle": "1.6.1",
  "@jimp/plugin-color": "1.6.1",
  "@jimp/plugin-contain": "1.6.1",
  "@jimp/plugin-cover": "1.6.1",
  "@jimp/plugin-crop": "1.6.1",
  "@jimp/plugin-displace": "1.6.1",
  "@jimp/plugin-dither": "1.6.1",
  "@jimp/plugin-fisheye": "1.6.1",
  "@jimp/plugin-flip": "1.6.1",
  "@jimp/plugin-hash": "1.6.1",
  "@jimp/plugin-mask": "1.6.1",
  "@jimp/plugin-print": "1.6.1",
  "@jimp/plugin-quantize": "1.6.1",
  "@jimp/plugin-resize": "1.6.1",
  "@jimp/plugin-rotate": "1.6.1",
  "@jimp/plugin-threshold": "1.6.1",
  "@jimp/types": "1.6.1",
  "@jimp/utils": "1.6.1",
  "@modelcontextprotocol/sdk": "1.29.0",
  "@tokenizer/inflate": "0.4.1",
  "@xmldom/xmldom": "0.8.15",
  ajv: "8.18.0",
  "ajv-formats": "3.0.1",
  "ansi-escapes": "7.3.0",
  "ansi-regex": "6.2.2",
  "ansi-styles": "6.2.3",
  "any-base": "1.1.0",
  "app-path": "4.0.0",
  "auto-bind": "5.0.1",
  "await-to-js": "3.0.0",
  "base64-js": "1.5.1",
  "bmp-ts": "1.0.9",
  "chalk@5.6.2": "5.6.2",
  "cli-boxes": "4.0.1",
  "cli-cursor": "4.0.0",
  "cli-truncate": "6.1.1",
  "code-excerpt": "4.0.0",
  commander: "12.1.0",
  "convert-to-spaces": "2.0.1",
  "cross-spawn": "7.0.6",
  debug: "4.4.3",
  diff: "9.0.0",
  environment: "1.1.0",
  "es-toolkit": "1.47.1",
  "escape-string-regexp": "2.0.0",
  eventsource: "3.0.7",
  "eventsource-parser": "3.0.6",
  execa: "5.1.1",
  "exif-parser": "0.1.12",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.2",
  "file-type": "21.3.4",
  "get-east-asian-width": "1.5.0",
  "get-stream": "6.0.1",
  gifwrap: "0.10.1",
  "has-flag": "4.0.0",
  "human-signals": "2.1.0",
  ieee754: "1.2.1",
  "image-q": "4.0.0",
  "indent-string": "5.0.0",
  ink: "7.1.1",
  "ink-picture": "2.1.0",
  "is-fullwidth-code-point@5.1.0": "5.1.0",
  "is-in-ci": "2.0.0",
  "is-stream": "2.0.1",
  "is-unicode-supported": "2.1.0",
  isexe: "2.0.0",
  "iterm2-version": "6.0.0",
  jimp: "1.6.1",
  "jpeg-js": "0.4.4",
  "json-schema-traverse": "1.0.0",
  marked: "15.0.12",
  "merge-stream": "2.0.0",
  mime: "3.0.0",
  "mimic-fn": "2.1.0",
  ms: "2.1.3",
  "npm-run-path": "4.0.1",
  omggif: "1.0.10",
  onetime: "5.1.2",
  openai: "7.10.0",
  pako: "1.0.11",
  "parse-bmfont-ascii": "1.0.6",
  "parse-bmfont-binary": "1.0.6",
  "parse-bmfont-xml": "1.1.6",
  "patch-console": "2.0.0",
  "path-key": "3.1.1",
  pixelmatch: "5.3.0",
  "pkce-challenge": "5.0.1",
  plist: "3.1.0",
  pngjs: "7.0.0",
  react: "19.3.0",
  "react-ink-textarea": "0.4.0",
  "react-reconciler": "0.33.0",
  "restore-cursor": "4.0.0",
  sax: "1.6.1",
  scheduler: "0.27.0",
  "shebang-command": "2.0.0",
  "shebang-regex": "3.0.0",
  "signal-exit": "3.0.7",
  "simple-xml-to-json": "1.2.7",
  sixel: "0.16.0",
  "slice-ansi": "9.0.0",
  "stack-utils": "2.0.6",
  "string-width@8.2.2": "8.2.2",
  "strip-ansi": "7.2.0",
  "strip-final-newline": "2.0.0",
  strtok3: "10.3.5",
  "supports-color@10.2.2": "10.2.2",
  "supports-color@7.2.0": "7.2.0",
  "terminal-query": "0.1.1",
  "terminal-size": "4.0.1",
  tinycolor2: "1.6.0",
  "token-types": "6.1.2",
  "uint8array-extras": "1.5.0",
  undici: "8.7.0",
  utif2: "4.1.0",
  which: "2.0.2",
  "widest-line": "6.0.0",
  "wrap-ansi": "10.0.1",
  ws: "8.21.3",
  xml2js: "0.5.0",
  "xmlbuilder@15.1.1": "15.1.1",
  "xmlbuilder@11.0.1": "11.0.1",
  "yoga-layout": "3.2.1",
  "zod@4.4.3": "4.4.3",
  "zod@3.25.76": "3.25.76",
  "zod-to-json-schema": "3.25.2",
};
const EXPECTED_RIPGREP = {
  path: "rg",
  package: "@vscode/ripgrep-darwin-arm64",
  packageVersion: "1.18.0",
  binaryVersion: "15.0.0",
  sha256: "6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1",
};

export function verifyCliPackage(manifest, files, runtimeManifest) {
  const errors = [];
  if (manifest.bin?.agentlink !== "dist/agentlink.js") {
    errors.push("bin.agentlink must be dist/agentlink.js");
  }
  if (manifest.os?.join(",") !== "darwin") errors.push("os must be darwin");
  if (manifest.cpu?.join(",") !== "arm64") errors.push("cpu must be arm64");
  if (manifest.engines?.node !== ">=22.19.0") {
    errors.push("engines.node must be >=22.19.0");
  }

  const dependencies = manifest.dependencies ?? {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (name.startsWith("@agentlink/")) {
      errors.push(`private runtime dependency ${name}`);
    }
    if (
      String(version).startsWith("file:") ||
      String(version).startsWith("workspace:")
    ) {
      errors.push(`repository-relative runtime dependency ${name}`);
    }
  }
  if (
    JSON.stringify(dependencies) !==
    JSON.stringify(EXPECTED_RUNTIME_DEPENDENCIES)
  ) {
    errors.push("runtime dependencies must be exactly @napi-rs/keyring@2.0.0");
  }

  const sortedFiles = [...files].sort();
  if (JSON.stringify(sortedFiles) !== JSON.stringify(EXPECTED_FILES)) {
    const missing = EXPECTED_FILES.filter(
      (file) => !sortedFiles.includes(file),
    );
    const unexpected = sortedFiles.filter(
      (file) => !EXPECTED_FILES.includes(file),
    );
    if (missing.length > 0) errors.push(`missing ${missing.join(", ")}`);
    if (unexpected.length > 0) {
      errors.push(`unexpected package files ${unexpected.join(", ")}`);
    }
  }

  if (!runtimeManifest || runtimeManifest.schemaVersion !== 1) {
    errors.push("invalid runtime manifest");
  } else {
    if (runtimeManifest.platform !== "darwin-arm64") {
      errors.push("runtime manifest platform must be darwin-arm64");
    }
    if (runtimeManifest.bundle !== "agentlink.js") {
      errors.push("runtime manifest bundle must be agentlink.js");
    }
    const externalImports = (runtimeManifest.externalImports ?? []).filter(
      (specifier) =>
        !specifier.startsWith("node:") && !builtinModules.includes(specifier),
    );
    if (
      JSON.stringify(externalImports) !==
      JSON.stringify(EXPECTED_EXTERNAL_IMPORTS)
    ) {
      errors.push("runtime manifest must externalize only @napi-rs/keyring");
    }
    if (
      JSON.stringify(runtimeManifest.bundledDependencies) !==
      JSON.stringify(EXPECTED_BUNDLED_DEPENDENCIES)
    ) {
      errors.push("runtime manifest bundled dependency inventory is invalid");
    }
    if (
      JSON.stringify(runtimeManifest.runtimeDependencies) !==
      JSON.stringify(EXPECTED_RUNTIME_DEPENDENCIES)
    ) {
      errors.push(
        "runtime manifest dependency closure does not match package.json",
      );
    }
    if (
      JSON.stringify(runtimeManifest.assets?.ripgrep) !==
      JSON.stringify(EXPECTED_RIPGREP)
    ) {
      errors.push("runtime manifest ripgrep asset is invalid");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid CLI package: ${errors.join("; ")}`);
  }
  return {
    runtimeDependencies: Object.keys(dependencies),
    externalImports: EXPECTED_EXTERNAL_IMPORTS,
    bundledDependencies: EXPECTED_BUNDLED_DEPENDENCIES,
    fileCount: sortedFiles.length,
    ripgrep: EXPECTED_RIPGREP,
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  throw new Error("Import verifyCliPackage from the package smoke test");
}
