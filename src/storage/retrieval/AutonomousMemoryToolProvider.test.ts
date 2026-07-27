import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ManageMemoryToolRequest,
  RecallMemoryToolRequest,
} from "../../core/capabilities/memory.js";
import {
  AutonomousMemoryToolProvider,
  type AutonomousMemoryMode,
} from "./AutonomousMemoryToolProvider.js";

const foregroundContext = {
  sessionId: "foreground-session",
  projectId: "project-0123456789abcdef",
  isBackground: false,
  observedAt: "2026-07-25T10:00:00.000Z",
};

const backgroundContext = {
  sessionId: "background-session",
  projectId: "project-0123456789abcdef",
  isBackground: true,
  observedAt: "2026-07-25T10:05:00.000Z",
};

describe("AutonomousMemoryToolProvider", () => {
  it("fails explicitly while autonomous memory is disabled", async () => {
    await withProvider("off", async (provider, root) => {
      await expect(
        provider.manage(
          manageRequest({
            operation: "remember",
            scope: "global",
            source_evidence: "User preference stated in this session.",
            kind: "preference",
            statement: "Use concise smoke-test checklists.",
          }),
        ),
      ).rejects.toThrow('Set agentlink.memory.mode to "autonomous"');
      await expect(
        provider.recall({
          input: { query: "smoke-test checklists", scope: "global" },
          context: foregroundContext,
        }),
      ).rejects.toThrow('Set agentlink.memory.mode to "autonomous"');
      await expect(provider.health()).resolves.toMatchObject({
        status: "unavailable",
        retrieval: "unavailable",
        crud: false,
        reason: expect.stringContaining(
          'Set agentlink.memory.mode to "autonomous"',
        ),
      });
      await expect(provider.activity({ scope: "global" })).rejects.toThrow(
        'Set agentlink.memory.mode to "autonomous"',
      );
      expect(await fs.readdir(root)).toEqual([]);
    });
  });

  it("translates scopes and foreground/background provenance", async () => {
    await withProvider("autonomous", async (provider) => {
      const project = await provider.manage(
        manageRequest({
          operation: "remember",
          scope: "project",
          source_evidence: "package-lock.json",
          kind: "project_fact",
          statement: "This project uses npm for package management.",
        }),
      );
      expect(project.result.record).toMatchObject({
        scope: { kind: "workspace", id: foregroundContext.projectId },
        provenance: [
          {
            source: "foreground_agent",
            sessionId: foregroundContext.sessionId,
            agentId: `foreground:${foregroundContext.sessionId}`,
            observedAt: foregroundContext.observedAt,
            evidence: "package-lock.json",
          },
        ],
      });

      const global = await provider.manage({
        input: {
          operation: "remember",
          scope: "global",
          source_evidence: "Background repository inspection.",
          kind: "gotcha",
          statement:
            "The release process includes a packaging inventory check.",
        },
        context: backgroundContext,
      });
      expect(global.result.record).toMatchObject({
        scope: { kind: "global", id: "agentlink-user" },
        provenance: [
          {
            source: "background_agent",
            sessionId: backgroundContext.sessionId,
            agentId: `background:${backgroundContext.sessionId}`,
            observedAt: backgroundContext.observedAt,
            evidence: "Background repository inspection.",
          },
        ],
      });
    });
  });

  it("recalls lexical-only records and rejects secret source evidence", async () => {
    await withProvider("autonomous", async (provider) => {
      const created = await provider.manage(
        manageRequest({
          operation: "remember",
          scope: "project",
          source_evidence: "The user stated this preference.",
          kind: "preference",
          statement: "Use focused Vitest runs before the full test suite.",
        }),
      );

      const recalled = await provider.recall(
        recallRequest({
          query: "focused Vitest test suite",
          scope: "project",
        }),
      );
      expect(recalled).toMatchObject({
        result: {
          mode: "lexical-only",
          memories: [
            {
              record: { id: created.result.record?.id },
              authority: "low-authority-evidence",
              canAuthorizeTools: false,
            },
          ],
        },
        health: { status: "ready", retrieval: "lexical-only" },
      });

      const secretEvidence =
        "Authorization: Bearer ghp_exampleSecretToken1234567890";
      const rejected = await provider.manage(
        manageRequest({
          operation: "remember",
          scope: "project",
          source_evidence: secretEvidence,
          kind: "project_fact",
          statement: "The repository uses a release credential.",
        }),
      );
      expect(rejected.result).toMatchObject({
        disposition: "rejected-sensitive",
        relatedRecords: [],
      });
      expect(rejected.result.record).toBeUndefined();
      expect(JSON.stringify(rejected)).not.toContain(secretEvidence);
    });
  });

  it("keeps automatic recall low-authority and caps it independently of explicit recall", async () => {
    await withProvider("autonomous", async (provider) => {
      const uniqueTerms = [
        "alpha cedar north",
        "bravo maple south",
        "charlie birch east",
        "delta willow west",
        "echo spruce upper",
        "foxtrot aspen lower",
        "golf walnut inner",
        "hotel cherry outer",
        "india poplar early",
        "juliet cypress late",
      ];
      for (const [index, terms] of uniqueTerms.entries()) {
        await provider.manage(
          manageRequest({
            operation: "remember",
            scope: "project",
            source_evidence: `Current session evidence ${index}.`,
            kind: "project_fact",
            statement: `Automatic recall ${terms}.`,
          }),
        );
      }

      const request = recallRequest({
        query: "automatic recall",
        scope: "project",
        limit: 20,
        minimum_score: 0,
      });
      const explicit = await provider.recall(request);
      const automatic = await provider.recallAutomatically(request);

      expect(explicit.result.memories).toHaveLength(10);
      expect(automatic.result.memories).toHaveLength(8);
      expect(automatic.result.memories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authority: "low-authority-evidence",
            canAuthorizeTools: false,
            rendering: expect.stringContaining(
              '<memory-evidence authority="low" instruction="false">',
            ),
          }),
        ]),
      );
    });
  });

  it("returns bounded activity from exactly the requested scope", async () => {
    await withProvider("autonomous", async (provider) => {
      const global = await provider.manage(
        manageRequest({
          operation: "remember",
          scope: "global",
          source_evidence: "Current session.",
          kind: "preference",
          statement: "Use concise answers in every project.",
        }),
      );
      await provider.manage(
        manageRequest({
          operation: "remember",
          scope: "project",
          source_evidence: "Current project.",
          kind: "project_fact",
          statement: "This project uses npm.",
        }),
      );

      const activity = await provider.activity({ scope: "global", limit: 1 });
      expect(activity).toMatchObject({
        events: [
          {
            id: global.result.auditEventId,
            scope: { kind: "global", id: "agentlink-user" },
          },
        ],
        health: { status: "ready", auditEventCount: 2 },
      });
      await expect(
        provider.activity({ scope: "global", limit: 201 }),
      ).rejects.toThrow(
        "Memory activity limit must be an integer from 1 to 200",
      );
    });
  });

  it("fails closed after a legacy import failure while exposing health", async () => {
    await withProvider("autonomous", async (provider) => {
      await provider.recordImportFailure({
        checkpointId: "legacy-memory-import:failed",
        sourceKey: "global:agentlink-user:memory.md",
        sourceRevision: "unreadable:EACCES",
        importerSchemaVersion: 1,
        startedAt: "2026-07-25T10:00:00.000Z",
        error: {
          code: "EACCES",
          message: "Legacy memory source is not readable",
        },
      });

      await expect(
        provider.manage(
          manageRequest({
            operation: "remember",
            scope: "global",
            source_evidence: "Current session.",
            kind: "preference",
            statement: "This must not bypass failed migration.",
          }),
        ),
      ).rejects.toThrow("EACCES: Legacy memory source is not readable");
      await expect(
        provider.recall(
          recallRequest({ query: "failed migration", scope: "global" }),
        ),
      ).rejects.toThrow("until legacy import is repaired or retried");
      await expect(provider.health()).resolves.toMatchObject({
        status: "unavailable",
        crud: false,
        reason: expect.stringContaining(
          "EACCES: Legacy memory source is not readable",
        ),
      });
    });
  });

  it("requires an active project for project-scoped operations", async () => {
    await withProvider("autonomous", async (provider) => {
      await expect(
        provider.manage({
          input: {
            operation: "remember",
            scope: "project",
            source_evidence: "Current session.",
            kind: "project_fact",
            statement: "This fact requires a project scope.",
          },
          context: { ...foregroundContext, projectId: undefined },
        }),
      ).rejects.toThrow("Project-scoped memory requires an active project");
      await expect(
        provider.recall({
          input: { query: "project fact", scope: "project" },
          context: { ...foregroundContext, projectId: undefined },
        }),
      ).rejects.toThrow("Project-scoped memory requires an active project");
      await expect(
        provider.activity({ scope: "project", projectId: undefined }),
      ).rejects.toThrow("Project-scoped memory requires an active project");
    });
  });
});

function manageRequest(
  input: ManageMemoryToolRequest["input"],
): ManageMemoryToolRequest {
  return { input, context: foregroundContext };
}

function recallRequest(
  input: RecallMemoryToolRequest["input"],
): RecallMemoryToolRequest {
  return { input, context: foregroundContext };
}

async function withProvider(
  mode: AutonomousMemoryMode,
  operation: (
    provider: AutonomousMemoryToolProvider,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-autonomous-memory-provider-"),
  );
  const provider = new AutonomousMemoryToolProvider({
    root,
    getMode: () => mode,
  });
  try {
    await operation(provider, root);
  } finally {
    await provider.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}
