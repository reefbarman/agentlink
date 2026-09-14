import type {
  AgentPrincipal,
  HostTool,
  HostToolExecutionContext,
  HostToolResolveRequest,
  ResolveAgentInstructionsRequest,
} from "@agentlink/core";
import { describe, expect, it } from "vitest";

import { createWorkspaceArtifactTools } from "./artifactTools.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const principal: AgentPrincipal = {
  tenantId: "local",
  subjectId: "project-a",
};

async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

function discovery(
  overrides: Partial<HostToolResolveRequest> = {},
): HostToolResolveRequest {
  return {
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    input: { text: "use artifacts", attachments: undefined },
    ...overrides,
  };
}

function execution(
  request: HostToolResolveRequest,
  overrides: Partial<HostToolExecutionContext> = {},
): HostToolExecutionContext {
  return {
    principal: request.principal,
    sessionId: request.sessionId,
    turnId: request.turnId,
    model: {
      model: { providerId: "fixture", modelId: "fixture-model" },
      source: "turn",
    },
    signal: undefined,
    ...overrides,
  };
}

function instructionRequest(
  request: HostToolResolveRequest,
): ResolveAgentInstructionsRequest {
  return {
    principal: request.principal,
    session: {
      schemaVersion: 1,
      sessionId: request.sessionId,
      principal: request.principal,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      runState: { phase: "idle" },
    },
    turnId: request.turnId,
  };
}

function findTool(tools: readonly HostTool[], name: string): HostTool {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}

function parseModelContent(result: Awaited<ReturnType<HostTool["execute"]>>) {
  if (typeof result.modelContent !== "string") {
    throw new Error("Expected textual tool output");
  }
  return JSON.parse(result.modelContent) as Record<string, unknown>;
}

describe("workspace artifact tools", () => {
  it("composes global/project precedence and activates instructions and rules every turn", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-artifacts-"),
    );
    try {
      const globalRoot = path.join(parent, "global");
      const projectRoot = path.join(parent, "project");
      await fs.mkdir(globalRoot);
      await fs.mkdir(projectRoot);
      await write(globalRoot, "AGENTS.md", "global instruction");
      await write(globalRoot, "rules/10-global.md", "global rule");
      await write(globalRoot, "commands/review.md", "global command");
      await write(projectRoot, "CLAUDE.md", "project instruction v1");
      await write(projectRoot, "rules/20-project.md", "project rule");
      await write(projectRoot, "commands/review.md", "project command");

      const artifacts = createWorkspaceArtifactTools({
        identity: "Standalone test agent",
        roots: [
          { id: "global", scope: "global", rootPath: globalRoot },
          { id: "project", scope: "project", rootPath: projectRoot },
        ],
      });
      const firstRequest = discovery();
      await expect(
        artifacts.resolveInstructions(instructionRequest(firstRequest)),
      ).resolves.toEqual({
        identity: "Standalone test agent",
        instructions: [
          "global instruction",
          "global rule",
          "project instruction v1",
          "project rule",
        ].join("\n\n"),
      });

      const firstTools = await artifacts.resolveTools(firstRequest);
      const firstList = parseModelContent(
        await findTool(firstTools, "list_artifacts").execute(
          {},
          execution(firstRequest),
        ),
      ) as {
        artifacts: Array<{ kind: string; name?: string; scope: string }>;
      };
      expect(firstList.artifacts).toEqual([
        expect.objectContaining({
          kind: "command",
          name: "review",
          scope: "project",
        }),
      ]);

      await write(projectRoot, "CLAUDE.md", "project instruction v2");
      await expect(
        artifacts.resolveInstructions(
          instructionRequest(discovery({ turnId: "turn-b" })),
        ),
      ).resolves.toMatchObject({
        instructions: expect.stringContaining("project instruction v2"),
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("lists bounded metadata and loads only an exact advertised skill or command", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-artifacts-"),
    );
    try {
      const root = path.join(parent, "project");
      await fs.mkdir(root);
      await write(root, "AGENTS.md", "private inline instruction");
      await write(root, "rules/private.md", "private inline rule");
      await write(
        root,
        "skills/test-helper/SKILL.md",
        "---\nname: test-helper\ndescription: Test helper\n---\nFollow the helper.",
      );
      await write(root, "commands/check.md", "Run a careful review.");
      const artifacts = createWorkspaceArtifactTools({
        roots: [{ id: "project", scope: "project", rootPath: root }],
      });
      const request = discovery();
      const tools = await artifacts.resolveTools(request);
      expect(tools.map((tool) => tool.definition.name)).toEqual([
        "list_artifacts",
        "load_artifact",
      ]);
      expect(
        JSON.stringify(tools.map((tool) => tool.definition.input_schema)),
      ).not.toContain("path");

      const listResult = await findTool(tools, "list_artifacts").execute(
        {},
        execution(request),
      );
      const listed = parseModelContent(listResult) as {
        catalogRevision: string;
        artifacts: Array<{
          id: string;
          kind: "skill" | "command";
          revision: string;
        }>;
      };
      expect(JSON.stringify(listed)).not.toContain("private inline");
      expect(listed.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
        "command",
        "skill",
      ]);
      expect(listResult.displayContent).toEqual(listed);

      const skill = listed.artifacts.find(
        (artifact) => artifact.kind === "skill",
      )!;
      const loaded = await findTool(tools, "load_artifact").execute(
        {
          catalogRevision: listed.catalogRevision,
          id: skill.id,
          revision: skill.revision,
        },
        execution(request),
      );
      expect(parseModelContent(loaded)).toMatchObject({
        artifact: { kind: "skill", id: skill.id },
        content: expect.stringContaining("Follow the helper."),
      });
      expect(loaded.displayContent).toEqual({
        artifact: expect.objectContaining({ kind: "skill", id: skill.id }),
        bytes: expect.any(Number),
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects stale catalog/file mutations and cross-turn or cross-principal execution", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-artifacts-"),
    );
    try {
      const root = path.join(parent, "project");
      await fs.mkdir(root);
      const skillPath = await write(
        root,
        "skills/test-helper/SKILL.md",
        "---\nname: test-helper\ndescription: Test helper\n---\nfirst version",
      );
      const artifacts = createWorkspaceArtifactTools({
        roots: [{ id: "project", scope: "project", rootPath: root }],
      });
      const request = discovery();
      const tools = await artifacts.resolveTools(request);
      const listTool = findTool(tools, "list_artifacts");
      const loadTool = findTool(tools, "load_artifact");
      const listed = parseModelContent(
        await listTool.execute({}, execution(request)),
      ) as {
        catalogRevision: string;
        artifacts: Array<{ id: string; revision: string }>;
      };
      const skill = listed.artifacts[0]!;
      const exactInput = {
        catalogRevision: listed.catalogRevision,
        id: skill.id,
        revision: skill.revision,
      };

      await expect(
        listTool.execute({}, execution(request, { turnId: "turn-b" })),
      ).resolves.toMatchObject({ isError: true });
      await expect(
        loadTool.execute(
          exactInput,
          execution(request, {
            principal: { tenantId: "local", subjectId: "project-b" },
          }),
        ),
      ).resolves.toMatchObject({ isError: true });

      await fs.writeFile(
        skillPath,
        "---\nname: test-helper\ndescription: Test helper\n---\nsecond version",
        "utf8",
      );
      expect(
        parseModelContent(
          await loadTool.execute(exactInput, execution(request)),
        ),
      ).toEqual({ error: "stale_advertised_artifact" });

      const freshTools = await artifacts.resolveTools(
        discovery({ turnId: "turn-b" }),
      );
      expect(
        parseModelContent(
          await findTool(freshTools, "load_artifact").execute(
            exactInput,
            execution(discovery({ turnId: "turn-b" })),
          ),
        ),
      ).toEqual({ error: "stale_advertised_artifact" });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("reports symlink escapes without exposing the outside path", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-artifacts-"),
    );
    try {
      const root = path.join(parent, "project");
      const outside = path.join(parent, "outside-secret");
      await fs.mkdir(path.join(root, "skills"), { recursive: true });
      await write(
        outside,
        "escaped/SKILL.md",
        "---\nname: escaped\ndescription: Outside\n---\nnot allowed",
      );
      await fs.symlink(
        path.join(outside, "escaped"),
        path.join(root, "skills", "escaped"),
      );
      const artifacts = createWorkspaceArtifactTools({
        roots: [{ id: "project", scope: "project", rootPath: root }],
      });
      const request = discovery();
      const tools = await artifacts.resolveTools(request);
      const listResult = await findTool(tools, "list_artifacts").execute(
        {},
        execution(request),
      );
      const listed = parseModelContent(listResult) as {
        artifacts: unknown[];
        diagnostics: Array<{ code: string; source: string }>;
      };
      expect(listed.artifacts).toEqual([]);
      expect(listed.diagnostics).toEqual([
        expect.objectContaining({
          code: "unsafe-symlink",
          source: "project:skills/escaped/SKILL.md",
        }),
      ]);
      expect(JSON.stringify(listResult)).not.toContain(outside);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("requires explicit absolute host-approved roots", () => {
    expect(() =>
      createWorkspaceArtifactTools({
        roots: [{ id: "project", scope: "project", rootPath: "relative" }],
      }),
    ).toThrow(/absolute/i);
  });
});
