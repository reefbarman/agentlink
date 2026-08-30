const WORKSPACE_PACKAGE_PREFIX = "@agentlink/";

export function findWorkspacePackageImports(metafile) {
  const imports = [];
  for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.path.startsWith(WORKSPACE_PACKAGE_PREFIX)) {
        imports.push({
          outputPath,
          importPath: imported.path,
          external: imported.external === true,
        });
      }
    }
  }
  return imports;
}

export function assertWorkspacePackagesBundled(metafile) {
  const imports = findWorkspacePackageImports(metafile);
  if (imports.length === 0) return;

  const details = imports
    .map(
      ({ outputPath, importPath, external }) =>
        `${outputPath}: ${importPath}${external ? " (external)" : ""}`,
    )
    .join("\n");
  throw new Error(
    `Shipped bundles must inline @agentlink workspace packages:\n${details}`,
  );
}

export const workspacePackageClosurePlugin = {
  name: "agentlink-workspace-package-closure",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (!result.metafile) {
        throw new Error("workspace_package_closure_metafile_missing");
      }
      assertWorkspacePackagesBundled(result.metafile);
    });
  },
};
