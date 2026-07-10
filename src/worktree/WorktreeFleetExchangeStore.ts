import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";

export type WorktreeFleetExchangeStatus =
  | "launching"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorktreeFleetExchangeRecord {
  schemaVersion: 1;
  id: string;
  parentFleetSessionId: string;
  sourceWorkspacePath: string;
  worktreePath?: string;
  childSessionId?: string;
  status: WorktreeFleetExchangeStatus;
  createdAt: number;
  updatedAt: number;
  cancelRequestedAt?: number;
  resultText?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export class WorktreeFleetExchangeStore {
  constructor(
    private readonly globalStoragePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async create(input: {
    id?: string;
    parentFleetSessionId: string;
    sourceWorkspacePath: string;
  }): Promise<WorktreeFleetExchangeRecord> {
    const timestamp = this.now();
    const record: WorktreeFleetExchangeRecord = {
      schemaVersion: 1,
      id: input.id ?? randomUUID(),
      parentFleetSessionId: input.parentFleetSessionId,
      sourceWorkspacePath: input.sourceWorkspacePath,
      status: "launching",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.write(record);
    return record;
  }

  async read(id: string): Promise<WorktreeFleetExchangeRecord | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.recordPath(id), "utf8"),
      ) as Partial<WorktreeFleetExchangeRecord>;
      return isRecord(parsed) ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async update(
    id: string,
    patch: Partial<Omit<WorktreeFleetExchangeRecord, "id" | "schemaVersion">>,
  ): Promise<WorktreeFleetExchangeRecord> {
    const current = await this.read(id);
    if (!current) throw new Error(`Worktree fleet exchange not found: ${id}`);
    const updated: WorktreeFleetExchangeRecord = {
      ...current,
      ...patch,
      id,
      schemaVersion: 1,
      updatedAt: this.now(),
    };
    await this.write(updated);
    return updated;
  }

  requestCancel(id: string): Promise<WorktreeFleetExchangeRecord> {
    return this.update(id, { cancelRequestedAt: this.now() });
  }

  private get directory(): string {
    return path.join(this.globalStoragePath, "worktree-fleet-exchanges");
  }

  private recordPath(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  private async write(record: WorktreeFleetExchangeRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.recordPath(record.id);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  }
}

function isRecord(
  value: Partial<WorktreeFleetExchangeRecord>,
): value is WorktreeFleetExchangeRecord {
  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.parentFleetSessionId === "string" &&
    typeof value.sourceWorkspacePath === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}
