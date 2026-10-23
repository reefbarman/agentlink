import * as fs from "node:fs";
import * as path from "node:path";

import {
  TRANSCRIPT_ATTACHMENTS_DIRNAME,
  rehydrateTranscriptPayloads,
} from "./transcriptPayloads.js";
import type {
  WorkspaceSessionCatalogEntry,
  WorkspaceSessionHistorySource,
  WorkspaceSessionRecord,
} from "@agentlink/core/workspace-session-history";

import type { AgentMessage } from "./types.js";
import type { SessionSummary } from "./SessionStore.js";
import type { SessionTranscriptSourceMessage } from "@agentlink/core/session-transcript-recall";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveWorkspaceSessionLocation } from "./workspaceSessionIdentity.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const DISCOVERY_CACHE_MS = 30_000;
const SESSIONS_FILE = "sessions.json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Saved AgentLink history belonging to another git worktree of a project. */
export interface SiblingWorktreeHistory {
  /** The sibling worktree root, reported to the model as the session origin. */
  rootPath: string;
  historyDirectory: string;
}

export type GitWorktreeListRunner = (cwd: string) => Promise<string>;

const defaultGitWorktreeList: GitWorktreeListRunner = async (cwd) => {
  const { stdout } = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  return stdout;
};

/** Parse `git worktree list --porcelain`, skipping bare entries. */
export function parseGitWorktreeList(output: string): string[] {
  const roots: string[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const worktree = lines.find((line) => line.startsWith("worktree "));
    if (!worktree || lines.includes("bare")) continue;
    roots.push(worktree.slice("worktree ".length));
  }
  return roots;
}

/**
 * Find other worktrees of the git repository containing `rootPath` that have
 * single-folder AgentLink history. Only reads files; never creates or migrates
 * another worktree's history. Returns an empty list outside a git repository.
 */
export async function discoverSiblingWorktreeHistories(
  rootPath: string,
  runGit: GitWorktreeListRunner = defaultGitWorktreeList,
): Promise<SiblingWorktreeHistory[]> {
  let output: string;
  try {
    output = await runGit(rootPath);
  } catch {
    return [];
  }
  const current = path.resolve(rootPath);
  const siblings: SiblingWorktreeHistory[] = [];
  const seen = new Set<string>();
  for (const root of parseGitWorktreeList(output)) {
    const resolvedRoot = path.resolve(root);
    if (resolvedRoot === current) continue;
    const location = resolveWorkspaceSessionLocation({
      workspaceFolders: [{ uri: { scheme: "file", fsPath: resolvedRoot } }],
      workspaceFile: undefined,
      fallbackCwd: resolvedRoot,
    });
    if (location.status !== "ready" || !location.historyDirectory) continue;
    const historyDirectory = path.resolve(location.historyDirectory);
    if (seen.has(historyDirectory)) continue;
    if (!fs.existsSync(path.join(historyDirectory, SESSIONS_FILE))) continue;
    seen.add(historyDirectory);
    siblings.push({ rootPath: resolvedRoot, historyDirectory });
  }
  return siblings;
}

/**
 * Read-only view of another worktree's saved foreground sessions. Unlike
 * SessionStore it never writes, migrates or caches the index, so it cannot
 * race the window that owns that history.
 */
export function createReadOnlyWorktreeHistorySource(
  sibling: SiblingWorktreeHistory,
): WorkspaceSessionHistorySource {
  const { historyDirectory, rootPath } = sibling;
  const readIndex = async (): Promise<SessionSummary[]> => {
    const parsed = await readJson(path.join(historyDirectory, SESSIONS_FILE));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (summary): summary is SessionSummary =>
        isRecord(summary) &&
        typeof summary.id === "string" &&
        SESSION_ID_PATTERN.test(summary.id) &&
        summary.background !== true,
    );
  };
  const entryFor = (summary: SessionSummary): WorkspaceSessionCatalogEntry => ({
    sessionId: summary.id,
    title: typeof summary.title === "string" ? summary.title : "",
    createdAt: finiteOr(summary.createdAt, 0),
    lastActiveAt: finiteOr(summary.lastActiveAt, 0),
    revision: `${summary.lastActiveAt}:${summary.messageCount}`,
    origin: rootPath,
  });

  return {
    async listSessions() {
      return (await readIndex()).map(entryFor);
    },
    async readSession(sessionId): Promise<WorkspaceSessionRecord | undefined> {
      if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
      const summary = (await readIndex()).find((s) => s.id === sessionId);
      if (!summary) return undefined;
      const sessionDir = path.join(historyDirectory, sessionId);
      const metadata = await readJson(path.join(sessionDir, "metadata.json"));
      if (!isRecord(metadata) || metadata.fleet !== undefined) return undefined;
      if (isRecord(metadata.summary) && metadata.summary.background === true) {
        return undefined;
      }
      const messagesFile = await readJson(
        path.join(sessionDir, "messages.json"),
      );
      if (!isRecord(messagesFile) || !Array.isArray(messagesFile.messages)) {
        return undefined;
      }
      const messages = rehydrateTranscriptPayloads(
        messagesFile.messages as AgentMessage[],
        (hash) => {
          try {
            return fs.readFileSync(
              path.join(
                sessionDir,
                TRANSCRIPT_ATTACHMENTS_DIRNAME,
                `${hash}.payload`,
              ),
              "utf-8",
            );
          } catch {
            return null;
          }
        },
      );
      return {
        ...entryFor(summary),
        messages: messages as readonly SessionTranscriptSourceMessage[],
      };
    },
  };
}

/**
 * The current project's sessions plus read-only sessions from sibling git
 * worktrees. The primary source wins when a session ID appears in both.
 */
export function createWorktreeInclusiveHistorySource(options: {
  primary: WorkspaceSessionHistorySource;
  discoverSiblings: () => Promise<readonly SiblingWorktreeHistory[]>;
  now?: () => number;
}): WorkspaceSessionHistorySource & {
  listSiblingRoots(): Promise<string[]>;
} {
  const now = options.now ?? Date.now;
  let cached:
    | {
        at: number;
        sources: Array<{
          rootPath: string;
          source: WorkspaceSessionHistorySource;
        }>;
      }
    | undefined;
  const siblings = async () => {
    if (cached && now() - cached.at < DISCOVERY_CACHE_MS) return cached.sources;
    let discovered: readonly SiblingWorktreeHistory[];
    try {
      discovered = await options.discoverSiblings();
    } catch {
      discovered = [];
    }
    cached = {
      at: now(),
      sources: discovered.map((sibling) => ({
        rootPath: sibling.rootPath,
        source: createReadOnlyWorktreeHistorySource(sibling),
      })),
    };
    return cached.sources;
  };

  return {
    async listSiblingRoots() {
      return (await siblings()).map((sibling) => sibling.rootPath);
    },
    async listSessions() {
      const entries = [...(await options.primary.listSessions())];
      const seen = new Set(entries.map((entry) => entry.sessionId));
      for (const { source } of await siblings()) {
        let listed: readonly WorkspaceSessionCatalogEntry[];
        try {
          listed = await source.listSessions();
        } catch {
          continue;
        }
        for (const entry of listed) {
          if (seen.has(entry.sessionId)) continue;
          seen.add(entry.sessionId);
          entries.push(entry);
        }
      }
      return entries;
    },
    async readSession(sessionId) {
      const primary = await options.primary.readSession(sessionId);
      if (primary) return primary;
      for (const { source } of await siblings()) {
        try {
          const record = await source.readSession(sessionId);
          if (record) return record;
        } catch {
          // An unreadable sibling must not hide sessions in other worktrees.
        }
      }
      return undefined;
    },
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
