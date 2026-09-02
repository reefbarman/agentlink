import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { build } from "esbuild";

const modules = [
  "agentEngine",
  "agentToolLoop",
  "hostAdapterContracts",
  "hostTools",
  "modelAuthProvider",
  "modelRequestScheduler",
  "modelRuntime",
  "nativeWebTools",
  "openAiCompatible",
  "providerStreamWatchdog",
  "sessionRepository",
  "sessionTranscriptRecall",
  "surfaceModelMessages",
  "toolCallBudget",
  "turnContracts",
  "turnExecution",
  "turnInteractions",
  "turnKernel",
  "turnLeases",
  "webAccess",
];

const sharedCoreModuleNames = new Set(modules);
const sharedCoreModulesPlugin = {
  name: "shared-core-modules",
  setup(build) {
    build.onResolve({ filter: /^\.\.?(?:\/.*)?\.js$/ }, (args) => {
      const module = args.path.split("/").at(-1)?.replace(/\.js$/, "");
      return module && sharedCoreModuleNames.has(module)
        ? { path: `./${module}.cjs`, external: true }
        : undefined;
    });
  },
};

if (!process.argv.includes("--metadata-only")) {
  await build({
    entryPoints: modules.map((module) => `src/${module}.ts`),
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: "dist/cjs",
    outExtension: { ".js": ".cjs" },
    sourcemap: true,
    plugins: [sharedCoreModulesPlugin],
  });
}

await mkdir("dist/cjs", { recursive: true });
await writeFile(
  "dist/cjs/index.cjs",
  [
    '"use strict";',
    `module.exports = Object.assign({}, ${modules
      .map((module) => `require("./${module}.cjs")`)
      .join(", ")});`,
    "",
  ].join("\n"),
);

async function listDeclarations(directory, prefix = "") {
  const declarations = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "cjs") continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      declarations.push(
        ...(await listDeclarations(`${directory}/${entry.name}`, relativePath)),
      );
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      declarations.push(relativePath.slice(0, -".d.ts".length));
    }
  }
  return declarations;
}

await Promise.all(
  (await listDeclarations("dist")).map(async (module) => {
    let declaration = await readFile(`dist/${module}.d.ts`, "utf8");
    declaration = declaration.replaceAll(
      /(["'])((?:\.\.?\/)[^"']+)\.js\1/g,
      (_match, quote, specifier) => `${quote}${specifier}.cjs${quote}`,
    );
    const moduleName = module.split("/").at(-1);
    declaration = declaration.replace(
      `//# sourceMappingURL=${moduleName}.d.ts.map`,
      `//# sourceMappingURL=${moduleName}.d.cts.map`,
    );
    const cjsDirectory = `dist/cjs/${module.split("/").slice(0, -1).join("/")}`;
    await mkdir(cjsDirectory, { recursive: true });
    await writeFile(`dist/cjs/${module}.d.cts`, declaration);

    const declarationMap = JSON.parse(
      await readFile(`dist/${module}.d.ts.map`, "utf8"),
    );
    declarationMap.file = `${moduleName}.d.cts`;
    declarationMap.sources = declarationMap.sources.map((source) =>
      source.startsWith(".") ? `../${source}` : source,
    );
    await writeFile(
      `dist/cjs/${module}.d.cts.map`,
      `${JSON.stringify(declarationMap)}\n`,
    );
  }),
);
