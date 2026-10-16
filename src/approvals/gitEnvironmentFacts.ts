import * as path from "path";

import { readFile, stat } from "fs/promises";

/**
 * Read-only git facts for reviewer context. Reads repository metadata files
 * directly (no git process), so lookups are cheap and side-effect free. Any
 * failure yields undefined rather than a guess.
 */
export interface GitEnvironment {
  repositoryRoot: string;
  /** Null when HEAD is detached. */
  branch: string | null;
  /** From refs/remotes/<remote>/HEAD; null when not recorded locally. */
  defaultBranch: string | null;
  /** Remote the current branch tracks, from branch.<name>.remote. */
  upstreamRemote: string | null;
  remotes: Array<{ name: string; url: string }>;
}

const MAX_REMOTES = 6;
const MAX_PARENT_LEVELS = 64;

export async function readGitEnvironment(
  cwd: string,
): Promise<GitEnvironment | undefined> {
  try {
    const located = await locateGitDirectory(cwd);
    if (!located) return undefined;
    const { repositoryRoot, gitDir, commonDir } = located;
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const branchMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = branchMatch?.[1] ?? null;
    const config = await readFile(path.join(commonDir, "config"), "utf8").catch(
      () => "",
    );
    const sections = parseGitConfig(config);
    const remotes = sections
      .filter((section) => section.kind === "remote" && section.values.url)
      .slice(0, MAX_REMOTES)
      .map((section) => ({
        name: section.name,
        url: stripUrlCredentials(section.values.url!),
      }));
    const upstreamRemote = branch
      ? (sections.find(
          (section) => section.kind === "branch" && section.name === branch,
        )?.values.remote ?? null)
      : null;
    const defaultRemote =
      upstreamRemote ??
      remotes.find((remote) => remote.name === "origin")?.name ??
      remotes[0]?.name;
    const defaultBranch = defaultRemote
      ? await readFile(
          path.join(commonDir, "refs", "remotes", defaultRemote, "HEAD"),
          "utf8",
        )
          .then(
            (content) =>
              new RegExp(
                `^ref:\\s*refs/remotes/${escapeRegExp(defaultRemote)}/(.+)$`,
              )
                .exec(content.trim())?.[1]
                ?.trim() ?? null,
          )
          .catch(() => null)
      : null;
    return { repositoryRoot, branch, defaultBranch, upstreamRemote, remotes };
  } catch {
    return undefined;
  }
}

async function locateGitDirectory(
  cwd: string,
): Promise<
  { repositoryRoot: string; gitDir: string; commonDir: string } | undefined
> {
  let current = path.resolve(cwd);
  for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
    const marker = path.join(current, ".git");
    const markerStat = await stat(marker).catch(() => undefined);
    if (markerStat?.isDirectory()) {
      return { repositoryRoot: current, gitDir: marker, commonDir: marker };
    }
    if (markerStat?.isFile()) {
      // Linked worktree: .git points at <common>/worktrees/<name>.
      const pointer = await readFile(marker, "utf8");
      const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer);
      if (!match) return undefined;
      const gitDir = path.resolve(current, match[1]!);
      const common = await readFile(path.join(gitDir, "commondir"), "utf8")
        .then((value) => path.resolve(gitDir, value.trim()))
        .catch(() => gitDir);
      return { repositoryRoot: current, gitDir, commonDir: common };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

interface GitConfigSection {
  kind: string;
  name: string;
  values: Record<string, string>;
}

/** Minimal parser for `[kind "name"]` sections; later keys win. */
export function parseGitConfig(config: string): GitConfigSection[] {
  const sections: GitConfigSection[] = [];
  let current: GitConfigSection | undefined;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/.exec(
      line,
    );
    if (header) {
      current = {
        kind: header[1]!.toLowerCase(),
        name: (header[2] ?? "").replace(/\\(.)/g, "$1"),
        values: {},
      };
      sections.push(current);
      continue;
    }
    const entry = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (entry && current) {
      current.values[entry[1]!.toLowerCase()] = entry[2]!.replace(
        /^"(.*)"$/,
        "$1",
      );
    }
  }
  return sections;
}

/** Drop userinfo from URL-style remotes; scp-style `user@host:` stays. */
export function stripUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
