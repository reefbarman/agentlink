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
}

export class FleetAutomationStore {
  private automations: FleetAutomation[] = [];

  constructor(
    private readonly filePath: string,
    private readonly launch: (workflow: FleetWorkflowRequest) => Promise<unknown>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      this.automations = Array.isArray(parsed)
        ? parsed.filter(isFleetAutomation)
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.automations = [];
    }
  }

  list(): FleetAutomation[] {
    return structuredClone(this.automations);
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
      (item) => item.enabled && item.nextRunAt !== undefined && item.nextRunAt <= now,
    );
    for (const item of due) {
      await this.launch(item.workflow);
      item.lastRunAt = now;
      item.nextRunAt = item.everyMs ? now + item.everyMs : undefined;
    }
    if (due.length) await this.save();
    return due.map((item) => item.id);
  }

  async trigger(eventType: string): Promise<string[]> {
    const matches = this.automations.filter(
      (item) => item.enabled && item.eventType === eventType,
    );
    for (const item of matches) {
      await this.launch(item.workflow);
      item.lastRunAt = this.now();
    }
    if (matches.length) await this.save();
    return matches.map((item) => item.id);
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.automations, null, 2)}\n`, "utf8");
    await fs.rename(temp, this.filePath);
  }
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
