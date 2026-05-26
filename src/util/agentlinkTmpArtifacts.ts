import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function trimTrailingSeparators(value: string): string {
  return value.replace(/[/\\]+$/, "");
}

function addPathAliases(paths: Set<string>, value: string): void {
  paths.add(value);

  if (process.platform !== "darwin") return;

  if (value.startsWith("/var/")) {
    paths.add(`/private${value}`);
  } else if (value.startsWith("/private/var/")) {
    paths.add(value.slice("/private".length));
  } else if (value === "/var") {
    paths.add("/private/var");
  } else if (value === "/private/var") {
    paths.add("/var");
  }
}

function addParentVariants(
  out: Set<string>,
  parent: string,
  childPrefix: string,
): void {
  const parents = new Set<string>();
  const literalParent = trimTrailingSeparators(parent);
  addPathAliases(parents, literalParent);

  try {
    addPathAliases(parents, trimTrailingSeparators(fs.realpathSync(parent)));
  } catch {
    // Parent may not exist in tests or constrained environments; aliases of the
    // literal parent still cover the emitted path shape.
  }

  for (const parentVariant of parents) {
    out.add(parentVariant + path.sep + childPrefix);
  }
}

// AgentLink-written temp artifacts that are safe to read without outside-
// workspace approval because the extension created them itself.
//
// - AgentEngine stores truncated tool results under /tmp/agentlink-results/.
// - outputFilter.saveOutputTempFile stores terminal output under
//   <os.tmpdir()>/agentlink-output-<rand>/output.txt.
//
// Include literal, realpath, and macOS /var ↔ /private/var aliases because the
// emitted path and resolveAndValidatePath's canonical path may differ.
export const AGENTLINK_TMP_ARTIFACT_PREFIXES: readonly string[] = (() => {
  const out = new Set<string>();
  addParentVariants(out, "/tmp", "agentlink-results/");
  addParentVariants(out, os.tmpdir(), "agentlink-output-");
  return [...out];
})();

export function isAgentlinkTmpArtifact(filePath: string): boolean {
  return AGENTLINK_TMP_ARTIFACT_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}
