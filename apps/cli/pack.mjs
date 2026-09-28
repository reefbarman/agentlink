import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCliPackage } from "../../scripts/verify-cli-package.mjs";

const root = import.meta.dirname;

export async function packCli() {
  const stage = path.join(root, "package-stage");
  const artifacts = path.join(root, "artifacts");
  const sourceManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const runtimeManifest = JSON.parse(
    await readFile(path.join(root, "dist/runtime-manifest.json"), "utf8"),
  );
  if (runtimeManifest.platform !== "darwin-arm64") {
    throw new Error(
      "Run npm run build:package --workspace @agentlink/cli before packaging.",
    );
  }
  const {
    devDependencies: _dev,
    optionalDependencies: _optional,
    scripts: _scripts,
    ...manifest
  } = sourceManifest;
  manifest.os = ["darwin"];
  manifest.cpu = ["arm64"];
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  try {
    for (const file of manifest.files) {
      await cp(path.join(root, file), path.join(stage, file), {
        recursive: true,
      });
    }
    await writeFile(
      path.join(stage, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", artifacts], {
        cwd: stage,
        encoding: "utf8",
      }),
    );
    verifyCliPackage(
      manifest,
      packed.files.map((file) => `package/${file.path}`),
      runtimeManifest,
    );
    return { packed, manifest, runtimeManifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { packed } = await packCli();
  console.log(packed.filename);
}
