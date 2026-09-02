import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures", "core-sdk-consumer");
const PACKAGES = ["protocol", "core"];

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(
      `Core SDK consumer gate command failed: ${command} ${args.join(" ")}\n${detail}`,
      { cause: error },
    );
  }
}

async function packPackage(packageName, packDirectory) {
  const { stdout } = await run(
    "npm",
    [
      "pack",
      "--workspace",
      `@agentlink/${packageName}`,
      "--json",
      "--pack-destination",
      packDirectory,
    ],
    { cwd: ROOT },
  );
  const parsed = JSON.parse(stdout);
  const artifact = parsed[0];
  const filename = artifact?.filename;
  if (!filename)
    throw new Error(`npm pack returned no ${packageName} artifact`);
  return {
    tarball: join(packDirectory, filename),
    files: new Set((artifact.files ?? []).map((file) => file.path)),
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertIsolatedConsumer(consumerDirectory) {
  const [consumerRoot, repositoryRoot] = await Promise.all([
    realpath(consumerDirectory),
    realpath(ROOT),
  ]);
  const relation = relative(repositoryRoot, consumerRoot);
  if (!relation.startsWith("..") || relation === "") {
    throw new Error("Packed consumer must run outside repository ancestry");
  }
  for (
    let ancestor = dirname(consumerRoot);
    ancestor !== dirname(ancestor);
    ancestor = dirname(ancestor)
  ) {
    for (const marker of ["node_modules", "package.json"]) {
      if (await pathExists(join(ancestor, marker))) {
        throw new Error(
          `Packed consumer ancestor unexpectedly contains ${marker}: ${ancestor}`,
        );
      }
    }
  }
  return consumerRoot;
}

function packageSpecifier(exportPath) {
  return exportPath === "."
    ? "@agentlink/core"
    : `@agentlink/core/${exportPath.slice(2)}`;
}

async function writeExportContracts(consumerDirectory, corePack) {
  const specifiers = Object.keys(corePack.exports).map(packageSpecifier);
  const esmImports = specifiers.map(
    (specifier, index) =>
      `import * as module${index} from ${JSON.stringify(specifier)};`,
  );
  const cjsImports = specifiers.map(
    (specifier, index) =>
      `import module${index} = require(${JSON.stringify(specifier)});`,
  );
  const runtimeEsm = specifiers.map(
    (specifier, index) =>
      `import * as module${index} from ${JSON.stringify(specifier)};`,
  );
  const runtimeCjs = specifiers.map(
    (specifier, index) =>
      `const module${index} = require(${JSON.stringify(specifier)});`,
  );
  const references = specifiers.map((_specifier, index) => `module${index}`);
  await Promise.all([
    writeFile(
      join(consumerDirectory, "all-exports-esm.ts"),
      `${esmImports.join("\n")}\nvoid [${references.join(", ")}];\n`,
    ),
    writeFile(
      join(consumerDirectory, "all-exports-cjs.cts"),
      `${cjsImports.join("\n")}\nvoid [${references.join(", ")}];\n`,
    ),
    writeFile(
      join(consumerDirectory, "all-exports-esm.mjs"),
      `${runtimeEsm.join("\n")}\nprocess.stdout.write(String([${references.join(", ")}].length));\n`,
    ),
    writeFile(
      join(consumerDirectory, "all-exports-cjs.cjs"),
      `${runtimeCjs.join("\n")}\nprocess.stdout.write(String([${references.join(", ")}].length));\n`,
    ),
    writeFile(
      join(consumerDirectory, "protocol-browser.mjs"),
      'import { resolveCoreModelCatalogReadiness } from "@agentlink/protocol/model-catalog";\nconsole.log(resolveCoreModelCatalogReadiness({ authenticated: true }).status);\n',
    ),
  ]);
  return { specifiers, exportCount: specifiers.length };
}

function exactLockedVersion(lock, packageName) {
  const version = lock.packages?.[`node_modules/${packageName}`]?.version;
  if (!version)
    throw new Error(`Root lockfile has no exact ${packageName} version`);
  return version;
}

async function assertInstalledResolution(consumerDirectory) {
  const { stdout: esmResolution } = await run(
    "node",
    [
      "--input-type=module",
      "--eval",
      'process.stdout.write(import.meta.resolve("@agentlink/core"))',
    ],
    { cwd: consumerDirectory },
  );
  const { stdout: cjsResolution } = await run(
    "node",
    [
      "--input-type=commonjs",
      "--eval",
      'process.stdout.write(require.resolve("@agentlink/core"))',
    ],
    { cwd: consumerDirectory },
  );
  const expectedCoreRoot = await realpath(
    join(consumerDirectory, "node_modules", "@agentlink", "core"),
  );
  for (const resolvedValue of [esmResolution, cjsResolution]) {
    const resolvedPath = resolvedValue.startsWith("file:")
      ? fileURLToPath(resolvedValue)
      : resolvedValue;
    const canonical = await realpath(resolvedPath);
    if (!canonical.startsWith(`${expectedCoreRoot}/`)) {
      throw new Error(
        `Core resolved outside consumer node_modules: ${canonical}`,
      );
    }
  }
  const protocolRoot = await realpath(
    join(consumerDirectory, "node_modules", "@agentlink", "protocol"),
  );
  const protocolPackage = JSON.parse(
    await readFile(join(protocolRoot, "package.json"), "utf8"),
  );
  if (
    await pathExists(
      join(expectedCoreRoot, "node_modules", "@agentlink", "protocol"),
    )
  ) {
    throw new Error("Core installed an unexpected nested protocol copy");
  }
  return {
    expectedCoreRoot,
    protocolRoot,
    protocolVersion: protocolPackage.version,
  };
}

async function assertUnsupportedCondition(
  consumerDirectory,
  specifiers,
  target,
) {
  for (const [index, specifier] of specifiers.entries()) {
    const probe = join(consumerDirectory, `unsupported-${target}-${index}.mjs`);
    await writeFile(
      probe,
      `import * as core from ${JSON.stringify(specifier)};\nconsole.log(Object.keys(core));\n`,
    );
    let rejected = false;
    try {
      await run(
        join(consumerDirectory, "node_modules", ".bin", "esbuild"),
        [
          probe,
          "--bundle",
          "--format=esm",
          "--platform=browser",
          `--conditions=${target}`,
          `--outfile=${join(consumerDirectory, `${target}-${index}.js`)}`,
        ],
        { cwd: consumerDirectory },
      );
    } catch (error) {
      rejected =
        error.message.includes(
          `The path ${JSON.stringify(specifier.replace("@agentlink/core", "."))}`,
        ) ||
        (error.message.includes("not currently exported") &&
          error.message.includes("@agentlink/core"));
      if (!rejected) throw error;
    }
    if (!rejected) {
      throw new Error(`${specifier} unexpectedly bundled for ${target}`);
    }
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agentlink-core-consumer-"),
  );
  try {
    const packDirectory = join(temporaryRoot, "packs");
    const consumerDirectory = join(temporaryRoot, "consumer");
    await Promise.all([
      cp(FIXTURE, consumerDirectory, { recursive: true }),
      mkdir(packDirectory, { recursive: true }),
    ]);
    await assertIsolatedConsumer(consumerDirectory);

    const [protocolArtifact, coreArtifact] = await Promise.all(
      PACKAGES.map((packageName) => packPackage(packageName, packDirectory)),
    );
    for (const requiredConsumerArtifact of ["README.md", "CHANGELOG.md"]) {
      if (!coreArtifact.files.has(requiredConsumerArtifact)) {
        throw new Error(
          `Core package tarball must include ${requiredConsumerArtifact}`,
        );
      }
    }
    if ([...coreArtifact.files].some((file) => file.endsWith(".tsbuildinfo"))) {
      throw new Error(
        "Core package tarball must not include TypeScript build metadata",
      );
    }
    const { tarball: protocolTarball } = protocolArtifact;
    const { tarball: coreTarball } = coreArtifact;
    const [rootPack, rootLock, protocolPack, corePack] = await Promise.all([
      readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
      readFile(join(ROOT, "package-lock.json"), "utf8").then(JSON.parse),
      readFile(join(ROOT, "packages", "protocol", "package.json"), "utf8").then(
        JSON.parse,
      ),
      readFile(join(ROOT, "packages", "core", "package.json"), "utf8").then(
        JSON.parse,
      ),
    ]);
    for (const [exportPath, conditions] of Object.entries(corePack.exports)) {
      if (conditions.browser !== null || conditions.edge !== null) {
        throw new Error(
          `Core export ${exportPath} must explicitly reject browser and edge conditions`,
        );
      }
    }
    const packageJsonPath = join(consumerDirectory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.dependencies = {
      "@agentlink/core": `file:${coreTarball}`,
      "@agentlink/protocol": `file:${protocolTarball}`,
    };
    packageJson.devDependencies = Object.fromEntries(
      ["@types/node", "esbuild", "typescript"].map((name) => [
        name,
        exactLockedVersion(rootLock, name),
      ]),
    );
    packageJson.overrides = {
      "@agentlink/protocol": `file:${protocolTarball}`,
    };
    packageJson.engines = { node: corePack.engines.node };
    packageJson.agentlinkProtocolVersion = protocolPack.version;
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const { specifiers, exportCount } = await writeExportContracts(
      consumerDirectory,
      corePack,
    );
    await writeFile(
      join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            lib: ["ES2022"],
            types: ["node"],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: [
            "consumer-contract.ts",
            "all-exports-esm.ts",
            "all-exports-cjs.cts",
          ],
        },
        null,
        2,
      )}\n`,
    );

    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      { cwd: consumerDirectory },
    );
    const resolution = await assertInstalledResolution(consumerDirectory);
    if (resolution.protocolVersion !== protocolPack.version) {
      throw new Error(
        "Installed protocol version does not match packed artifact",
      );
    }
    if (rootPack.devDependencies.typescript === undefined) {
      throw new Error("Root TypeScript version is unavailable");
    }
    const bin = (name) => join(consumerDirectory, "node_modules", ".bin", name);
    await run(bin("tsc"), ["-p", "tsconfig.json"], {
      cwd: consumerDirectory,
    });
    const [{ stdout: esmCount }, { stdout: cjsCount }, { stdout }] =
      await Promise.all([
        run("node", ["all-exports-esm.mjs"], { cwd: consumerDirectory }),
        run("node", ["all-exports-cjs.cjs"], { cwd: consumerDirectory }),
        run("node", ["consumer.mjs"], { cwd: consumerDirectory }),
      ]);
    if (Number(esmCount) !== exportCount || Number(cjsCount) !== exportCount) {
      throw new Error("Not every packed export loaded under ESM and CommonJS");
    }
    const result = JSON.parse(stdout.trim());
    if (
      result.ok !== true ||
      result.catalogModels !== 1 ||
      result.singletonTurns !== 2 ||
      result.recreatedTurns !== 1 ||
      result.cancellation !== "cancelled" ||
      result.cancellationPersisted !== true ||
      result.tenantIsolation !== true
    ) {
      throw new Error(
        `Packed consumer returned an invalid result: ${stdout.trim()}`,
      );
    }

    await run(
      bin("esbuild"),
      [
        "protocol-browser.mjs",
        "--bundle",
        "--format=esm",
        "--platform=browser",
        "--conditions=browser",
        "--outfile=protocol-browser.js",
      ],
      { cwd: consumerDirectory },
    );
    await Promise.all(
      ["browser", "edge"].map((target) =>
        assertUnsupportedCondition(consumerDirectory, specifiers, target),
      ),
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          coreVersion: corePack.version,
          protocolVersion: protocolPack.version,
          exportPaths: exportCount,
          esmAndCjsExportsLoaded: true,
          browserAndEdgeImportsRejected: true,
          protocolBrowserImportAccepted: true,
          isolatedResolution: resolution.expectedCoreRoot.startsWith(
            `${await realpath(consumerDirectory)}/node_modules/`,
          ),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
