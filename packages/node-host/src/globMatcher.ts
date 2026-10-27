import picomatch from "picomatch";

/**
 * Compile a workspace-relative glob with VS Code `RelativePattern` semantics:
 * `*.ts` matches only top-level files, `**` crosses directories, simple brace
 * groups expand, and dot-prefixed names match. Paths use `/` separators.
 */
export function createNodeHostGlobMatcher(
  glob: string,
): (relativePath: string) => boolean {
  const matcher = picomatch(glob, { dot: true });
  return (relativePath) => matcher(relativePath);
}
