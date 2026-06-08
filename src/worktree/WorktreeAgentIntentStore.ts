import * as fs from "fs/promises";
import * as path from "path";

import { randomUUID } from "crypto";

export interface WorktreeAgentStartupIntent {
  id: string;
  createdAt: number;
  expiresAt: number;
  sourceWorkspacePath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  task: string;
  prompt: string;
  mode?: string;
  autoSubmit: boolean;
  consumedAt?: number;
}

export interface WorktreeAgentIntentStoreOptions {
  now?: () => number;
  realpath?: (value: string) => Promise<string>;
}

const INTENT_DIR = "worktree-intents";
const RETAIN_CONSUMED_MS = 10 * 60 * 1000;

export class WorktreeAgentIntentStore {
  private readonly now: () => number;
  private readonly realpathFn: (value: string) => Promise<string>;

  constructor(
    private readonly globalStoragePath: string,
    opts: WorktreeAgentIntentStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.realpathFn = opts.realpath ?? fs.realpath;
  }

  async writeIntent(
    intent: Omit<
      WorktreeAgentStartupIntent,
      "id" | "createdAt" | "expiresAt"
    > & {
      id?: string;
      ttlMs?: number;
      createdAt?: number;
      expiresAt?: number;
    },
  ): Promise<WorktreeAgentStartupIntent> {
    const createdAt = intent.createdAt ?? this.now();
    const full: WorktreeAgentStartupIntent = {
      id: intent.id ?? randomUUID(),
      createdAt,
      expiresAt:
        intent.expiresAt ?? createdAt + (intent.ttlMs ?? 10 * 60 * 1000),
      sourceWorkspacePath: intent.sourceWorkspacePath,
      worktreePath: intent.worktreePath,
      branch: intent.branch,
      baseRef: intent.baseRef,
      task: intent.task,
      prompt: intent.prompt,
      ...(intent.mode ? { mode: intent.mode } : {}),
      autoSubmit: intent.autoSubmit,
    };

    await fs.mkdir(this.intentDir, { recursive: true });
    const finalPath = this.intentPath(full.id);
    const tmpPath = path.join(
      this.intentDir,
      `.${full.id}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(tmpPath, `${JSON.stringify(full, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.rename(tmpPath, finalPath);
    return full;
  }

  async consumeIntentForWorkspace(
    workspacePath: string,
  ): Promise<WorktreeAgentStartupIntent | null> {
    await fs.mkdir(this.intentDir, { recursive: true });
    const target = await this.normalizePath(workspacePath);
    const files = await this.listIntentFiles();
    const now = this.now();

    for (const fileName of files) {
      const filePath = path.join(this.intentDir, fileName);
      const intent = await this.readIntentFile(filePath);
      if (!intent) continue;

      if (intent.expiresAt <= now) {
        await this.safeUnlink(filePath);
        continue;
      }

      if (intent.consumedAt) {
        if (now - intent.consumedAt > RETAIN_CONSUMED_MS) {
          await this.safeUnlink(filePath);
        }
        continue;
      }

      const intentWorktree = await this.normalizePath(intent.worktreePath);
      if (!pathsEqual(target, intentWorktree)) continue;

      const consumed: WorktreeAgentStartupIntent = {
        ...intent,
        consumedAt: now,
      };
      await fs.writeFile(filePath, `${JSON.stringify(consumed, null, 2)}\n`, {
        encoding: "utf8",
      });
      return consumed;
    }

    return null;
  }

  async pruneExpired(): Promise<void> {
    await fs.mkdir(this.intentDir, { recursive: true });
    const now = this.now();
    for (const fileName of await this.listIntentFiles()) {
      const filePath = path.join(this.intentDir, fileName);
      const intent = await this.readIntentFile(filePath);
      if (!intent) continue;
      if (
        intent.expiresAt <= now ||
        (intent.consumedAt && now - intent.consumedAt > RETAIN_CONSUMED_MS)
      ) {
        await this.safeUnlink(filePath);
      }
    }
  }

  private get intentDir(): string {
    return path.join(this.globalStoragePath, INTENT_DIR);
  }

  private intentPath(intentId: string): string {
    return path.join(this.intentDir, `${intentId}.json`);
  }

  private async listIntentFiles(): Promise<string[]> {
    try {
      return (await fs.readdir(this.intentDir))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return [];
      throw err;
    }
  }

  private async readIntentFile(
    filePath: string,
  ): Promise<WorktreeAgentStartupIntent | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorktreeAgentStartupIntent>;
      if (!isValidIntent(parsed)) return null;
      return parsed;
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      return null;
    }
  }

  private async normalizePath(value: string): Promise<string> {
    const resolved = path.resolve(value);
    try {
      return path.normalize(await this.realpathFn(resolved));
    } catch {
      return path.normalize(resolved);
    }
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (!isNodeError(err) || err.code !== "ENOENT") throw err;
    }
  }
}

function pathsEqual(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isValidIntent(
  value: Partial<WorktreeAgentStartupIntent>,
): value is WorktreeAgentStartupIntent {
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    typeof value.sourceWorkspacePath === "string" &&
    typeof value.worktreePath === "string" &&
    typeof value.branch === "string" &&
    typeof value.baseRef === "string" &&
    typeof value.task === "string" &&
    typeof value.prompt === "string" &&
    typeof value.autoSubmit === "boolean" &&
    (value.mode === undefined || typeof value.mode === "string") &&
    (value.consumedAt === undefined || typeof value.consumedAt === "number")
  );
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}
