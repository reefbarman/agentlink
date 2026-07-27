import { AutonomousMemoryService } from "../../../core/memory/AutonomousMemoryService.js";
import { LanceDbMemoryRepository } from "../LanceDbMemoryRepository.js";
import type { MemoryProvenance } from "../../../core/memory/contracts.js";
import { withRetrievalStoreLock } from "../retrievalStoreLock.js";

const root = requireEnvironment("MEMORY_FIXTURE_ROOT");
const role = requireEnvironment("MEMORY_FIXTURE_ROLE");
const repository = new LanceDbMemoryRepository({ root });
const service = new AutonomousMemoryService(repository, {
  createId: createPrefixedId(role),
});
const scope = { kind: "workspace" as const, id: "memory-process-workspace" };

void run().catch((error) => {
  send({
    type: "error",
    message:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});

async function run(): Promise<void> {
  if (role === "reader") {
    await repository.health();
    send({ type: "ready", role });
    process.on("message", (message) => {
      void handleReaderMessage(message).catch((error) => {
        send({
          type: "error",
          message:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      });
    });
    return;
  }

  if (role === "writer-a" || role === "writer-b") {
    const result = await service.manage({
      operation: "remember",
      scope,
      kind: "project_fact",
      statement:
        role === "writer-a"
          ? "The native package target is darwin arm64."
          : "Browser instance identities are workspace scoped.",
      provenance: fixtureProvenance(role),
    });
    send({ type: "committed", role, result });
    await repository.close();
    return;
  }

  if (role === "crash-owner") {
    await withRetrievalStoreLock(root, async () => {
      send({ type: "locked", role });
      await new Promise<void>(() => undefined);
    });
    return;
  }

  throw new Error(`Unknown memory fixture role: ${role}`);
}

async function handleReaderMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "inspect") {
    const records = await repository.list(scope);
    const audits = await repository.listAudit();
    const revisionCounts = await Promise.all(
      records.map(
        async (record) =>
          [
            record.id,
            (await repository.listRevisions(record.id)).length,
          ] as const,
      ),
    );
    send({
      type: "inspection",
      records,
      auditCount: audits.length,
      revisionCounts: Object.fromEntries(revisionCounts),
      health: await repository.health(),
    });
    return;
  }
  if (message.type === "close") {
    await repository.close();
    send({ type: "closed" });
    process.exit(0);
  }
}

function fixtureProvenance(agentId: string): MemoryProvenance {
  return {
    source: "foreground_agent",
    observedAt: "2026-07-25T00:00:00.000Z",
    sessionId: "memory-process-session",
    agentId,
  };
}

function createPrefixedId(
  prefix: string,
): (kind: "record" | "audit") => string {
  let value = 0;
  return (kind) => `${prefix}-${kind}-${++value}`;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function send(message: object): void {
  process.send?.(message);
}
