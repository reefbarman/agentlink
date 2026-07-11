import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import type { FleetWorkflowRequest } from "./FleetWorkflows.js";

export interface FleetAutomation {
  id: string;
  name: string;
  workflow: FleetWorkflowRequest;
  enabled: boolean;
  everyMs?: number;
  eventType?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  failureCount?: number;
  lastError?: string;
}

export interface FleetAutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed" | "skipped_reentrant";
  error?: string;
}

export class FleetAutomationStore {
  private automations: FleetAutomation[] = [];
  private historyEntries: FleetAutomationRun[] = [];
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly launch: (
      workflow: FleetWorkflowRequest,
    ) => Promise<unknown>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      ) as unknown;
      if (Array.isArray(parsed)) {
        this.automations = parsed.filter(isFleetAutomation);
        this.historyEntries = [];
      } else if (parsed && typeof parsed === "object") {
        const state = parsed as { automations?: unknown; history?: unknown };
        this.automations = Array.isArray(state.automations)
          ? state.automations.filter(isFleetAutomation)
          : [];
        this.historyEntries = Array.isArray(state.history)
          ? state.history.filter(isFleetAutomationRun)
          : [];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.automations = [];
    }
  }

  list(): FleetAutomation[] {
    return structuredClone(this.automations);
  }

  history(automationId?: string): FleetAutomationRun[] {
    return structuredClone(
      automationId
        ? this.historyEntries.filter(
            (entry) => entry.automationId === automationId,
          )
        : this.historyEntries,
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<FleetAutomation> {
    const automation = this.automations.find((item) => item.id === id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    automation.enabled = enabled;
    if (enabled && automation.everyMs) {
      automation.nextRunAt = this.now() + automation.everyMs;
    }
    await this.save();
    return structuredClone(automation);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.automations.length;
    this.automations = this.automations.filter((item) => item.id !== id);
    if (this.automations.length === before) return false;
    await this.save();
    return true;
  }

  async schedule(input: {
    name: string;
    workflow: FleetWorkflowRequest;
    everyMs?: number;
    eventType?: string;
  }): Promise<FleetAutomation> {
    if (!input.everyMs && !input.eventType) {
      throw new Error("Automation requires everyMs or eventType");
    }
    const automation: FleetAutomation = {
      id: randomUUID(),
      name: input.name,
      workflow: input.workflow,
      enabled: true,
      everyMs: input.everyMs,
      eventType: input.eventType,
      nextRunAt: input.everyMs ? this.now() + input.everyMs : undefined,
    };
    this.automations.push(automation);
    await this.save();
    return structuredClone(automation);
  }

  async runDue(): Promise<string[]> {
    const now = this.now();
    const due = this.automations.filter(
      (item) =>
        item.enabled && item.nextRunAt !== undefined && item.nextRunAt <= now,
    );
    for (const item of due) {
      await this.runAutomation(item);
    }
    if (due.length) await this.save();
    return due.map((item) => item.id);
  }

  async trigger(eventType: string): Promise<string[]> {
    const matches = this.automations.filter(
      (item) => item.enabled && item.eventType === eventType,
    );
    for (const item of matches) {
      await this.runAutomation(item);
    }
    if (matches.length) await this.save();
    return matches.map((item) => item.id);
  }

  private async runAutomation(item: FleetAutomation): Promise<void> {
    const startedAt = this.now();
    if (this.activeRuns.has(item.id)) {
      this.recordRun({
        id: randomUUID(),
        automationId: item.id,
        startedAt,
        completedAt: startedAt,
        status: "skipped_reentrant",
      });
      return;
    }
    this.activeRuns.add(item.id);
    try {
      await this.launch(item.workflow);
      item.lastRunAt = this.now();
      item.failureCount = 0;
      item.lastError = undefined;
      item.nextRunAt = item.everyMs ? this.now() + item.everyMs : undefined;
      this.recordRun({
        id: randomUUID(),
        automationId: item.id,
        startedAt,
        completedAt: this.now(),
        status: "completed",
      });
    } catch (error) {
      item.failureCount = (item.failureCount ?? 0) + 1;
      item.lastError = error instanceof Error ? error.message : String(error);
      const backoffMs = Math.min(
        60 * 60 * 1000,
        30_000 * 2 ** Math.min(10, item.failureCount - 1),
      );
      item.nextRunAt = this.now() + backoffMs;
      this.recordRun({
        id: randomUUID(),
        automationId: item.id,
        startedAt,
        completedAt: this.now(),
        status: "failed",
        error: item.lastError,
      });
    } finally {
      this.activeRuns.delete(item.id);
    }
  }

  private recordRun(run: FleetAutomationRun): void {
    this.historyEntries = [...this.historyEntries.slice(-499), run];
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(
      temp,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          automations: this.automations,
          history: this.historyEntries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.rename(temp, this.filePath);
  }
}

function isFleetAutomationRun(value: unknown): value is FleetAutomationRun {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FleetAutomationRun>;
  return (
    typeof item.id === "string" &&
    typeof item.automationId === "string" &&
    typeof item.startedAt === "number" &&
    typeof item.completedAt === "number" &&
    typeof item.status === "string"
  );
}

function isFleetAutomation(value: unknown): value is FleetAutomation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FleetAutomation>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.enabled === "boolean" &&
    Boolean(item.workflow && typeof item.workflow.kind === "string")
  );
}
