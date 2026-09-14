import * as esbuild from "esbuild";

import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const output = path.join(root, "dist", "agentlink.js");
await rm(path.dirname(output), { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  metafile: true,
  banner: {
    // sixel/upng.js assigns to an undeclared UPNG global. The source predates
    // strict ESM bundles, so provide the binding it expects inside this bundle.
    js: '#!/usr/bin/env node\nimport { createRequire as __agentlinkCreateRequire } from "node:module";\nconst require = __agentlinkCreateRequire(import.meta.url);\nvar UPNG;',
  },
  define: {
    __AGENTLINK_CLI_VERSION__: JSON.stringify(manifest.version),
    "process.env.DEV": "undefined",
  },
  alias: {
    "react-devtools-core": path.join(
      root,
      "src",
      "tui",
      "reactDevtoolsStub.ts",
    ),
  },
  external: ["@napi-rs/keyring"],
});
await chmod(output, 0o755);
const outputMetadata =
  build.metafile.outputs[path.relative(process.cwd(), output)];
if (!outputMetadata) throw new Error("CLI bundle metadata is unavailable");
const OPTIONAL_EXTERNAL_IMPORTS = new Set(["bufferutil", "utf-8-validate"]);
const externalImports = [
  ...new Set(
    outputMetadata.imports
      .filter((entry) => entry.external)
      .map((entry) => entry.path)
      .filter((specifier) => !OPTIONAL_EXTERNAL_IMPORTS.has(specifier)),
  ),
].sort();
const unexpectedExternalImports = externalImports.filter(
  (specifier) =>
    specifier !== "@napi-rs/keyring" &&
    !specifier.startsWith("node:") &&
    ![
      "assert",
      "buffer",
      "child_process",
      "crypto",
      "events",
      "fs",
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
    ].includes(specifier),
);
if (unexpectedExternalImports.length > 0) {
  throw new Error(
    `Unexpected CLI external imports: ${unexpectedExternalImports.join(", ")}`,
  );
}

const ripgrepPackage = "@vscode/ripgrep-darwin-arm64";
const ripgrepVersion = "1.18.0";
const ripgrepSha256 =
  "6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1";
const ripgrepManifestPath = require.resolve(`${ripgrepPackage}/package.json`);
const ripgrepRoot = path.dirname(ripgrepManifestPath);
const installedRipgrepManifest = JSON.parse(
  await readFile(ripgrepManifestPath, "utf8"),
);
if (installedRipgrepManifest.version !== ripgrepVersion) {
  throw new Error(
    `Expected ${ripgrepPackage} ${ripgrepVersion}, found ${installedRipgrepManifest.version}`,
  );
}
const ripgrepSource = path.join(ripgrepRoot, "bin", "rg");
const ripgrepBytes = await readFile(ripgrepSource);
const actualRipgrepSha256 = createHash("sha256")
  .update(ripgrepBytes)
  .digest("hex");
if (actualRipgrepSha256 !== ripgrepSha256) {
  throw new Error(
    `Pinned ripgrep checksum mismatch: expected ${ripgrepSha256}, found ${actualRipgrepSha256}`,
  );
}
const ripgrepOutput = path.join(root, "dist", "rg");
await copyFile(ripgrepSource, ripgrepOutput);
await chmod(ripgrepOutput, 0o755);
const bundledPackages = await collectBundledPackages(build.metafile);
const thirdPartyNotices = await renderThirdPartyNotices([
  ...bundledPackages,
  {
    name: ripgrepPackage,
    version: ripgrepVersion,
    license: "MIT",
    source: "https://github.com/microsoft/vscode-ripgrep",
    details: [
      "Packaged binary: ripgrep 15.0.0 (darwin-arm64)",
      `SHA-256: ${ripgrepSha256}`,
    ],
    licenseFiles: [path.join(ripgrepRoot, "LICENSE")],
  },
]);
await writeFile(path.join(root, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices, {
  mode: 0o644,
});
await writeFile(
  path.join(root, "dist", "runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      platform: "darwin-arm64",
      bundle: "agentlink.js",
      externalImports,
      bundledDependencies: bundledDependencyInventory(bundledPackages),
      runtimeDependencies: { "@napi-rs/keyring": "2.0.0" },
      assets: {
        ripgrep: {
          path: "rg",
          package: ripgrepPackage,
          packageVersion: ripgrepVersion,
          binaryVersion: "15.0.0",
          sha256: ripgrepSha256,
        },
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o644 },
);

function bundledDependencyInventory(packages) {
  const nameCounts = new Map();
  for (const entry of packages) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  return Object.fromEntries(
    packages.map((entry) => [
      nameCounts.get(entry.name) === 1
        ? entry.name
        : `${entry.name}@${entry.version}`,
      entry.version,
    ]),
  );
}

async function collectBundledPackages(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const packageRoot = nodeModulesPackageRoot(path.resolve(input));
    if (!packageRoot || packages.has(packageRoot)) continue;
    const packageManifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    const packageLicense =
      typeof packageManifest.license === "string"
        ? packageManifest.license
        : packageManifest.name === "exif-parser" &&
            packageManifest.version === "0.1.12"
          ? "MIT"
          : undefined;
    if (
      typeof packageManifest.name !== "string" ||
      typeof packageManifest.version !== "string" ||
      !packageLicense
    ) {
      throw new Error(`Bundled package metadata is incomplete: ${packageRoot}`);
    }
    let licenseFiles = (await readdir(packageRoot))
      .filter((entry) =>
        /^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/iu.test(entry),
      )
      .sort()
      .map((entry) => path.join(packageRoot, entry));
    if (
      licenseFiles.length === 0 &&
      packageManifest.name === "yoga-layout" &&
      packageManifest.version === "3.2.1"
    ) {
      licenseFiles = [path.join(root, "licenses", "yoga-layout-3.2.1-LICENSE")];
    }
    if (licenseFiles.length === 0 && packageLicense) {
      const readme = (await readdir(packageRoot)).find((entry) =>
        /^readme(?:\..*)?$/iu.test(entry),
      );
      if (readme) {
        const readmePath = path.join(packageRoot, readme);
        const readmeContent = await readFile(readmePath, "utf8");
        if (
          /(?:^|\n)(?:#+\s*)?(?:the\s+)?licen[cs]e\b/iu.test(readmeContent) ||
          /permission is hereby granted, free of charge/iu.test(readmeContent)
        ) {
          licenseFiles = [readmePath];
        }
      }
    }
    if (licenseFiles.length === 0) {
      throw new Error(
        `Bundled package has no license file: ${packageManifest.name}`,
      );
    }
    const repository = packageManifest.repository;
    const source =
      typeof repository === "string"
        ? repository
        : repository && typeof repository.url === "string"
          ? repository.url
          : undefined;
    packages.set(packageRoot, {
      name: packageManifest.name,
      version: packageManifest.version,
      license: packageLicense,
      source,
      details: [],
      licenseFiles,
    });
  }
  return [...packages.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function nodeModulesPackageRoot(absoluteInput) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = absoluteInput.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const modulesRoot = absoluteInput.slice(0, markerIndex + marker.length - 1);
  const packageSegments = absoluteInput
    .slice(markerIndex + marker.length)
    .split(path.sep);
  const packageName = packageSegments[0]?.startsWith("@")
    ? packageSegments.slice(0, 2)
    : packageSegments.slice(0, 1);
  return packageName.length > 0
    ? path.join(modulesRoot, ...packageName)
    : undefined;
}

async function renderThirdPartyNotices(packages) {
  const sections = [];
  for (const entry of packages.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const metadata = [
      `## ${entry.name} ${entry.version}`,
      "",
      `License: ${entry.license}`,
      ...(entry.source ? [`Source: ${entry.source}`] : []),
      ...entry.details,
    ];
    const licenses = [];
    for (const licenseFile of entry.licenseFiles) {
      licenses.push(
        `### ${path.basename(licenseFile)}`,
        "",
        (await readFile(licenseFile, "utf8")).trim(),
      );
    }
    sections.push([...metadata, "", ...licenses].join("\n"));
  }
  return `# AgentLink CLI third-party notices\n\nThis file lists third-party software bundled directly in the private CLI tarball. Runtime npm dependencies retain their own package licences.\n\n${sections.join("\n\n")}\n`;
}
