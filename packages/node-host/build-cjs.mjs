import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { build } from "esbuild";

const modules = (await readdir("src", { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts"),
  )
  .map((entry) => entry.name.slice(0, -".ts".length))
  .sort();

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/cjs/index.cjs",
  sourcemap: true,
  external: ["@agentlink/*", "@modelcontextprotocol/*", "@napi-rs/*"],
});

await mkdir("dist/cjs", { recursive: true });
await Promise.all(
  modules.map(async (module) => {
    let declaration = await readFile(`dist/${module}.d.ts`, "utf8");
    declaration = declaration.replaceAll(
      /(["'])((?:\.\.?\/)[^"']+)\.js\1/gu,
      (_match, quote, specifier) => `${quote}${specifier}.cjs${quote}`,
    );
    declaration = declaration.replace(
      `//# sourceMappingURL=${module}.d.ts.map`,
      `//# sourceMappingURL=${module}.d.cts.map`,
    );
    await writeFile(`dist/cjs/${module}.d.cts`, declaration);

    const declarationMap = JSON.parse(
      await readFile(`dist/${module}.d.ts.map`, "utf8"),
    );
    declarationMap.file = `${module}.d.cts`;
    declarationMap.sources = declarationMap.sources.map((source) =>
      source.startsWith(".") ? `../${source}` : source,
    );
    await writeFile(
      `dist/cjs/${module}.d.cts.map`,
      `${JSON.stringify(declarationMap)}\n`,
    );
  }),
);
