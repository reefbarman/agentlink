import type { AgentConfig, AgentMessage } from "./types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildModeInstructionBlock,
  buildPromptArtifacts,
  buildSystemPrompt,
} from "./systemPrompt.js";

import { AgentSession } from "./AgentSession.js";
import type { ContentBlock } from "./providers/types.js";
import type { PersistedActiveSkillState } from "./persistenceContracts.js";
import type { SkillEntry } from "./skillLoader.js";
import type { SkillCatalogProjection } from "./skillCatalogProjection.js";
import {
  createProjectlessSessionScope,
  type SessionProjectScope,
} from "../core/workspaceProjects.js";
import type { PromptProfileResolution } from "../core/promptProfile.js";

function makeSkillCatalogProjection(
  revision: string,
  omissions: SkillCatalogProjection["omissions"] = [],
): SkillCatalogProjection {
  return {
    schemaVersion: 1,
    revision,
    budgetChars: 1_024,
    renderedChars: 0,
    discoveredCount: omissions.length,
    enabledCount: omissions.length,
    advertisedCount: 0,
    truncatedCount: 0,
    omittedCount: omissions.length,
    sourceChars: 0,
    deferredChars: 0,
    retrievalFallbackRequired: omissions.length > 0,
    advertised: [],
    omissions,
    catalogXml: "",
  };
}

function makePromptArtifacts(
  systemPrompt: string,
  promptProfile: PromptProfileResolution = {
    profile: "compatibility" as const,
    source: "compatibility-default" as const,
    policyRevision: "prompt-profile-policy-v1" as const,
    providerId: "test",
    modelId: "test-model",
  },
) {
  return {
    systemPrompt,
    promptProfile,
    skills: [],
    advertisedRules: [],
    promptBreakdown: {
      sections: [
        { label: "test", chars: systemPrompt.length, estimatedTokens: 1 },
      ],
      totalChars: systemPrompt.length,
      estimatedTokens: 1,
    },
  };
}

// Mock prompt builders so create() doesn't hit the filesystem
vi.mock("./systemPrompt.js", () => {
  const buildSystemPromptMock = vi.fn().mockResolvedValue("mock system prompt");
  const buildPromptArtifactsMock = vi
    .fn()
    .mockResolvedValue(makePromptArtifacts("mock system prompt"));
  const buildModeInstructionBlockMock = vi
    .fn()
    .mockImplementation((mode: string) =>
      Promise.resolve(`<current_mode mode="${mode}">mock block</current_mode>`),
    );
  return {
    buildSystemPrompt: buildSystemPromptMock,
    buildPromptArtifacts: buildPromptArtifactsMock,
    buildModeInstructionBlock: buildModeInstructionBlockMock,
  };
});

const mockedBuildSystemPrompt = vi.mocked(buildSystemPrompt);
const mockedBuildPromptArtifacts = vi.mocked(buildPromptArtifacts);
const mockedBuildModeInstructionBlock = vi.mocked(buildModeInstructionBlock);

const testProjectScope: SessionProjectScope = {
  schemaVersion: 1,
  kind: "project",
  projectId: "project-test",
  workspaceFolderUri: "file:///test",
  displayName: "test",
  rootPath: "/test",
};

const testConfig: AgentConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

async function makeSession(
  opts: Partial<Parameters<typeof AgentSession.createForLegacyCwd>[0]> = {},
): Promise<AgentSession> {
  return AgentSession.createForLegacyCwd({
    mode: "code",
    config: testConfig,
    cwd: "/test",
    ...opts,
  });
}

function makeSkillEntry(
  name: string,
  revision: string,
  allowedTools?: string[],
): SkillEntry {
  const skillDirectory = `/test/.agentlink/skills/${name}`;
  const skillPath = `${skillDirectory}/SKILL.md`;
  return {
    id: `project:agentlink:.agentlink/skills/${name}`,
    name,
    description: `${name} skill`,
    revision,
    sourceChars: 128,
    provenance: {
      scope: "project",
      namespace: "agentlink",
      sourceRoot: "/test/.agentlink/skills",
      skillDirectory,
      realSkillPath: skillPath,
      priority: 1,
    },
    skillPath,
    allowedTools,
    restrictions: { allowedTools },
    permissions: { requestedTools: [] },
    dependencies: [],
    recommendations: [],
    resolvedDependencies: [],
    enabled: true,
  };
}

describe("AgentSession", () => {
  beforeEach(() => {
    mockedBuildSystemPrompt.mockClear();
    mockedBuildPromptArtifacts.mockClear();
    mockedBuildModeInstructionBlock.mockClear();
    mockedBuildSystemPrompt.mockResolvedValue("mock system prompt");
    mockedBuildPromptArtifacts.mockResolvedValue(
      makePromptArtifacts("mock system prompt"),
    );
  });

  describe("creation", () => {
    it("starts with no messages", async () => {
      const session = await makeSession();
      expect(session.getMessages()).toHaveLength(0);
      expect(session.messageCount).toBe(0);
    });

    it("assigns a unique id", async () => {
      const a = await makeSession();
      const b = await makeSession();
      expect(a.id).not.toBe(b.id);
      expect(a.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("owns an immutable project scope and derives its root from that scope", async () => {
      const session = await AgentSession.create({
        mode: "code",
        config: testConfig,
        projectScope: testProjectScope,
      });

      expect(session.projectScope).toEqual(testProjectScope);
      expect(session.requireProjectRoot()).toBe("/test");
      expect(Object.isFrozen(session.projectScope)).toBe(true);
      expect(() => {
        (session.projectScope as { displayName: string }).displayName =
          "changed";
      }).toThrow();
    });

    it("restores unavailable transcripts without assembling a prompt or inventing a root", () => {
      const unavailableScope: SessionProjectScope = {
        ...testProjectScope,
        rootPath: undefined,
      };
      const session = AgentSession.createTranscriptOnly({
        mode: "code",
        config: testConfig,
        projectScope: unavailableScope,
        projectAvailability: "missing",
      });

      expect(session.systemPrompt).toBe("");
      expect(session.contextBreakdown.prompt.sections).toEqual([]);
      expect(mockedBuildPromptArtifacts).not.toHaveBeenCalled();
      expect(() => session.requireProjectRoot()).toThrow(
        "Project 'test' is unavailable for local execution.",
      );
    });

    it("creates a chat-only Ask session for the reserved projectless scope", async () => {
      const session = await AgentSession.create({
        mode: "ask",
        config: testConfig,
        projectScope: createProjectlessSessionScope(),
      });

      expect(session.mode).toBe("ask");
      expect(session.agentMode.slug).toBe("ask");
      expect(session.projectAvailability).toBe("unavailable");
      expect(session.systemPrompt).toContain(
        "without an open workspace folder",
      );
      expect(mockedBuildPromptArtifacts).not.toHaveBeenCalled();
      expect(() => session.requireProjectRoot()).toThrow(
        "Project 'No folder' is unavailable for local execution.",
      );
    });

    it("refuses non-Ask construction for the reserved projectless scope", async () => {
      await expect(
        AgentSession.create({
          mode: "code",
          config: testConfig,
          projectScope: createProjectlessSessionScope(),
        }),
      ).rejects.toThrow("Projectless sessions are available only in Ask mode.");
    });

    it("refuses executable construction for a scope without an available root", async () => {
      await expect(
        AgentSession.create({
          mode: "code",
          config: testConfig,
          projectScope: { ...testProjectScope, rootPath: undefined },
        }),
      ).rejects.toThrow("Project 'test' is unavailable for local execution.");
      expect(mockedBuildPromptArtifacts).not.toHaveBeenCalled();
    });

    it("stores the mode and model", async () => {
      const session = await makeSession({ mode: "ask" });
      expect(session.mode).toBe("ask");
      expect(session.model).toBe("claude-sonnet-4-6");
    });

    it("uses the system prompt from buildSystemPrompt", async () => {
      const session = await makeSession();
      expect(session.systemPrompt).toBe("mock system prompt");
    });

    it("defaults background to false", async () => {
      const session = await makeSession();
      expect(session.background).toBe(false);
    });

    it("sets background flag when specified", async () => {
      const session = await makeSession({ background: true });
      expect(session.background).toBe(true);
    });

    it("starts with idle status", async () => {
      const session = await makeSession();
      expect(session.status).toBe("idle");
    });

    it("starts with New Chat title", async () => {
      const session = await makeSession();
      expect(session.title).toBe("New Chat");
    });

    it("stores providerId when specified", async () => {
      const session = await makeSession({ providerId: "codex" });
      expect(session.providerId).toBe("codex");
    });

    it("providerId is undefined when not specified", async () => {
      const session = await makeSession();
      expect(session.providerId).toBeUndefined();
    });

    it("passes MCP disclosure catalog to buildPromptArtifacts and stores the snapshot", async () => {
      const mcpToolDisclosure = {
        inlineTools: [],
        deferredTools: [],
        catalog: [
          {
            serverName: "linear",
            toolCount: 46,
            estimatedTokens: 10_214,
            representativeTools: ["list_issues"],
          },
        ],
      };

      const session = await makeSession({ mcpToolDisclosure });

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({
          mcpToolCatalog: mcpToolDisclosure.catalog,
        }),
      );
      expect(session.mcpToolDisclosure).toBe(mcpToolDisclosure);
    });

    it("passes providerId to buildPromptArtifacts on create", async () => {
      await makeSession({ providerId: "codex" });
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
    });

    it("passes disabled skill IDs to buildPromptArtifacts on create", async () => {
      const disabledSkillIds = [
        "project:agentlink:.agentlink/skills/private-helper",
      ];
      const session = await makeSession({
        config: { ...testConfig, disabledSkillIds },
      });

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ disabledSkillIds }),
      );
      expect(session.disabledSkillIds).toEqual(disabledSkillIds);
      expect(session.disabledSkillIds).not.toBe(disabledSkillIds);
    });

    it("freezes the resolved skill catalog budget across prompt rebuilds", async () => {
      const budgetChars = 2_345;
      mockedBuildPromptArtifacts.mockResolvedValueOnce({
        ...makePromptArtifacts("initial prompt"),
        skillCatalog: {
          schemaVersion: 1,
          revision: "catalog-revision",
          budgetChars,
          renderedChars: 0,
          discoveredCount: 0,
          enabledCount: 0,
          advertisedCount: 0,
          truncatedCount: 0,
          omittedCount: 0,
          sourceChars: 0,
          deferredChars: 0,
          retrievalFallbackRequired: false,
          advertised: [],
          omissions: [],
          catalogXml: "",
        },
      });
      const session = await makeSession();

      expect(session.skillCatalogBudgetChars).toBe(budgetChars);

      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("rebuilt prompt"),
      );
      await session.rebuildSystemPrompt();
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ skillCatalogBudgetChars: budgetChars }),
      );

      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("ask prompt"),
      );
      await session.setMode("ask");
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ skillCatalogBudgetChars: budgetChars }),
      );
    });

    it("keeps the committed skill catalog projection in sync across prompt changes", async () => {
      const initial = makeSkillCatalogProjection("initial", [
        {
          id: "project:agentlink:.agentlink/skills/omitted",
          name: "omitted",
          revision: "skill-revision",
          reason: "budget",
        },
      ]);
      mockedBuildPromptArtifacts.mockResolvedValueOnce({
        ...makePromptArtifacts("initial prompt"),
        skillCatalog: initial,
      });
      const session = await makeSession();
      expect(session.getSkillCatalogProjection()).toBe(initial);

      const rebuilt = makeSkillCatalogProjection("rebuilt");
      mockedBuildPromptArtifacts.mockResolvedValueOnce({
        ...makePromptArtifacts("rebuilt prompt"),
        skillCatalog: rebuilt,
      });
      await session.rebuildSystemPrompt();
      expect(session.getSkillCatalogProjection()).toBe(rebuilt);

      const switched = makeSkillCatalogProjection("switched");
      mockedBuildPromptArtifacts.mockResolvedValueOnce({
        ...makePromptArtifacts("ask prompt"),
        skillCatalog: switched,
      });
      await session.setMode("ask");
      expect(session.getSkillCatalogProjection()).toBe(switched);
    });

    it("defaults autoCondenseThreshold to 0.9 when not provided", async () => {
      const configWithoutThreshold: AgentConfig = {
        ...testConfig,
        autoCondenseThreshold: undefined as unknown as number,
      };
      const session = await AgentSession.createForLegacyCwd({
        mode: "code",
        config: configWithoutThreshold,
        cwd: "/test",
      });
      expect(session.autoCondenseThreshold).toBe(0.9);
    });

    it("defaults codexStatefulResponses to true when not provided", async () => {
      const session = await makeSession();
      expect(session.codexStatefulResponses).toBe(true);
    });

    it("defaults codexStoreResponses to false when not provided", async () => {
      const session = await makeSession();
      expect(session.codexStoreResponses).toBe(false);
    });

    it("stores codexStoreResponses when configured", async () => {
      const session = await makeSession({
        config: { ...testConfig, codexStoreResponses: true },
      });
      expect(session.codexStoreResponses).toBe(true);
    });
  });

  describe("messages", () => {
    it("clears active skill tool restrictions when a new user message starts", async () => {
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [makeSkillEntry("safe-review", "a".repeat(64), ["read_file"])],
      });
      const session = await makeSession();

      session.trackLoadedSkill({
        id: "project:agentlink:.agentlink/skills/safe-review",
        name: "safe-review",
        revision: "a".repeat(64),
        skillPath: "/test/.agentlink/skills/safe-review/SKILL.md",
      });
      expect(session.getActiveSkillAllowedTools()).toEqual(["read_file"]);

      session.addUserMessage("new task");
      expect(session.getActiveSkillAllowedTools()).toBeUndefined();
      expect(session.getLoadedSkills()).toEqual(["safe-review"]);
    });

    it("rejects stale canonical skill activations without changing policy", async () => {
      const skill = makeSkillEntry("safe-review", "a".repeat(64), [
        "read_file",
      ]);
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [skill],
      });
      const session = await makeSession();

      expect(
        session.trackLoadedSkill({
          id: skill.id,
          name: skill.name,
          revision: "b".repeat(64),
          skillPath: skill.skillPath,
        }),
      ).toBe(false);
      expect(session.getActiveSkillAllowedTools()).toBeUndefined();
      expect(session.getLoadedSkills()).toEqual([]);
    });

    it("intersects active skill restrictions independent of load order", async () => {
      const broad = makeSkillEntry("broad", "a".repeat(64), [
        "read_file",
        "search_files",
      ]);
      const narrow = makeSkillEntry("narrow", "b".repeat(64), ["read_file"]);
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [broad, narrow],
      });

      const activate = (session: AgentSession, skill: SkillEntry) =>
        session.trackLoadedSkill({
          id: skill.id,
          name: skill.name,
          revision: skill.revision,
          skillPath: skill.skillPath,
        });

      const broadThenNarrow = await makeSession();
      expect(activate(broadThenNarrow, broad)).toBe(true);
      expect(activate(broadThenNarrow, narrow)).toBe(true);
      expect(broadThenNarrow.getActiveSkillAllowedTools()).toEqual([
        "read_file",
      ]);

      const narrowThenBroad = await makeSession();
      expect(activate(narrowThenBroad, narrow)).toBe(true);
      expect(narrowThenBroad.getActiveSkillAllowedTools()).toEqual([
        "read_file",
      ]);
      expect(activate(narrowThenBroad, broad)).toBe(true);
      expect(narrowThenBroad.getActiveSkillAllowedTools()).toEqual([
        "read_file",
      ]);
      expect(narrowThenBroad.getActiveSkillPolicy().revision).toBe(
        broadThenNarrow.getActiveSkillPolicy().revision,
      );
    });

    it("snapshots and restores exact active skill authority", async () => {
      const broad = makeSkillEntry("broad", "a".repeat(64), [
        "read_file",
        "search_files",
      ]);
      const narrow = makeSkillEntry("narrow", "b".repeat(64), ["read_file"]);
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [broad, narrow],
        skillCatalog: makeSkillCatalogProjection("catalog-before"),
      });
      const source = await makeSession();
      for (const skill of [broad, narrow]) {
        expect(
          source.trackLoadedSkill({
            id: skill.id,
            name: skill.name,
            revision: skill.revision,
            skillPath: skill.skillPath,
          }),
        ).toBe(true);
      }

      const snapshot = source.getActiveSkillState();
      expect(snapshot).toEqual({
        schemaVersion: 1,
        catalogRevision: "catalog-before",
        activations: [broad, narrow]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(({ id, name, revision }) => ({ id, name, revision })),
        policy: source.getActiveSkillPolicy(),
      });

      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("restored prompt"),
        skills: [broad, narrow],
        // Catalog revision is audit provenance. Unrelated catalog changes do not
        // revoke an exact active batch whose skills and recomputed policy match.
        skillCatalog: makeSkillCatalogProjection("catalog-after"),
      });
      const restored = await makeSession();
      restored.restoreFromStore({
        id: "restored",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        loadedSkills: ["legacy-display-only"],
        activeSkillState: snapshot,
        messages: [],
      });

      expect(restored.getActiveSkillAllowedTools()).toEqual(["read_file"]);
      expect(restored.getLoadedSkills()).toEqual([
        "legacy-display-only",
        "broad",
        "narrow",
      ]);
      expect(restored.getActiveSkillState()).toMatchObject({
        catalogRevision: "catalog-after",
        activations: snapshot?.activations,
      });
    });

    it.each([
      [
        "a stale activation revision",
        (state: PersistedActiveSkillState) => ({
          ...state,
          activations: state.activations.map((activation, index) =>
            index === 0
              ? { ...activation, revision: "f".repeat(64) }
              : activation,
          ),
        }),
      ],
      [
        "a mismatched policy revision",
        (state: PersistedActiveSkillState) => ({
          ...state,
          policy: { ...state.policy, revision: "f".repeat(64) },
        }),
      ],
      [
        "duplicate canonical activations",
        (state: PersistedActiveSkillState) => ({
          ...state,
          activations: [state.activations[0]!, state.activations[0]!],
        }),
      ],
    ])(
      "rejects the entire restored skill batch for %s",
      async (_label, mutate) => {
        const skill = makeSkillEntry("safe-review", "a".repeat(64), [
          "read_file",
        ]);
        mockedBuildPromptArtifacts.mockResolvedValue({
          ...makePromptArtifacts("mock system prompt"),
          skills: [skill],
          skillCatalog: makeSkillCatalogProjection("catalog"),
        });
        const source = await makeSession();
        source.trackLoadedSkill({
          id: skill.id,
          name: skill.name,
          revision: skill.revision,
          skillPath: skill.skillPath,
        });
        const snapshot = source.getActiveSkillState();
        expect(snapshot).toBeDefined();

        const restored = await makeSession();
        restored.restoreFromStore({
          id: "restored",
          title: "Restored",
          createdAt: 1,
          lastActiveAt: 2,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          loadedSkills: [skill.name],
          activeSkillState: mutate(snapshot!),
          messages: [],
        });

        expect(restored.getLoadedSkills()).toEqual([skill.name]);
        expect(restored.getActiveSkillAllowedTools()).toBeUndefined();
        expect(restored.getActiveSkillState()).toBeUndefined();
      },
    );

    it("revokes active authority when refresh changes the same skill revision", async () => {
      const original = makeSkillEntry("safe-review", "a".repeat(64), [
        "read_file",
      ]);
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [original],
        skillCatalog: makeSkillCatalogProjection("catalog-before"),
      });
      const session = await makeSession();
      session.trackLoadedSkill({
        id: original.id,
        name: original.name,
        revision: original.revision,
        skillPath: original.skillPath,
      });
      expect(session.getActiveSkillAllowedTools()).toEqual(["read_file"]);

      const changed = makeSkillEntry("safe-review", "b".repeat(64), [
        "read_file",
        "write_file",
      ]);
      session.setAdvertisedSkills([changed]);

      expect(session.getLoadedSkills()).toEqual([original.name]);
      expect(session.getActiveSkillAllowedTools()).toBeUndefined();
      expect(session.getActiveSkillState()).toBeUndefined();
    });

    it("does not authorize legacy loaded skill names", async () => {
      const skill = makeSkillEntry("safe-review", "a".repeat(64), [
        "read_file",
      ]);
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [skill],
        skillCatalog: makeSkillCatalogProjection("catalog"),
      });
      const restored = await makeSession();
      restored.restoreFromStore({
        id: "legacy",
        title: "Legacy",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        loadedSkills: [skill.name],
        messages: [],
      });

      expect(restored.getLoadedSkills()).toEqual([skill.name]);
      expect(restored.getActiveSkillAllowedTools()).toBeUndefined();
      expect(restored.getActiveSkillState()).toBeUndefined();
    });

    it("addUserMessage appends a user message", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "hello" });
    });

    it("bumps transcriptRevision on every transcript mutation and holds it steady on reads", async () => {
      const session = await makeSession();
      // Creation seeds the mode instruction anchor, which counts as revision 1.
      const base = session.transcriptRevision;

      session.addUserMessage("hello");
      expect(session.transcriptRevision).toBe(base + 1);

      session.appendAssistantTurn([{ type: "text", text: "hi" }]);
      expect(session.transcriptRevision).toBe(base + 2);

      session.appendToolResults([
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
      ]);
      expect(session.transcriptRevision).toBe(base + 3);

      expect(
        session.applyFinalMarker({ status: "completed", source: "engine" }),
      ).toBe(true);
      expect(session.transcriptRevision).toBe(base + 4);

      session.appendRuntimeError({ message: "boom", retryable: false });
      expect(session.transcriptRevision).toBe(base + 5);
      // In-place update of the matching runtime error still counts as a mutation.
      session.appendRuntimeError({ message: "boom", retryable: true });
      expect(session.transcriptRevision).toBe(base + 6);

      expect(session.popLastMessage("assistant")).toBeDefined();
      expect(session.transcriptRevision).toBe(base + 7);
      // A non-matching pop leaves the transcript (and revision) untouched.
      expect(session.popLastMessage("assistant")).toBeUndefined();
      expect(session.transcriptRevision).toBe(base + 7);

      session.replaceMessages([{ role: "user", content: "condensed" }]);
      expect(session.transcriptRevision).toBe(base + 8);

      // Reads never bump the revision.
      session.getAllMessages();
      session.getMessages();
      expect(session.transcriptRevision).toBe(base + 8);
    });

    it("persists user-message origin metadata in uiHint", async () => {
      const session = await makeSession();
      session.addUserMessage("hello from phone", { origin: "browser" });
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        role: "user",
        content: "hello from phone",
        uiHint: {
          userMessage: {
            origin: "browser",
          },
        },
      });
    });

    it("appendAssistantTurn appends an assistant message", async () => {
      const session = await makeSession();
      const blocks: ContentBlock[] = [{ type: "text", text: "response" }];
      session.appendAssistantTurn(blocks);
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "assistant", content: blocks });
    });

    it("appendAssistantMessage preserves provider-private replay", async () => {
      const session = await makeSession();
      const message: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: {
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_1",
                name: "web_search",
                input: { query: "AgentLink" },
              },
            ],
          },
          serializedBytes: 1,
        },
      };

      session.appendAssistantMessage(message);

      expect(session.getMessages()).toEqual([message]);
      expect(session.getMessages()[0]).toBe(message);
    });

    it("appendToolResults appends tool results as a user message", async () => {
      const session = await makeSession();
      session.appendAssistantTurn([
        { type: "tool_use", id: "tu_123", name: "read_file", input: {} },
      ]);
      const results: Parameters<typeof session.appendToolResults>[0] = [
        {
          type: "tool_result" as const,
          tool_use_id: "tu_123",
          content: "file contents",
          mcpApprovalPromotion: {
            serverName: "linear",
            bareToolName: "list_issues",
            scopes: ["session", "project", "global"] as const,
          },
        },
      ];
      session.appendToolResults(results);
      const messages = session.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual({ role: "user", content: results });
    });

    it("getMessages drops tool results whose tool_use is missing from the prior assistant turn", async () => {
      const session = await makeSession();
      session.appendToolResults([
        {
          type: "tool_result" as const,
          tool_use_id: "tu_orphan",
          content: "stale",
        },
      ]);
      expect(session.getMessages()).toHaveLength(0);
      // Raw history is untouched — only the API view is sanitized.
      expect(session.getAllMessages()).toHaveLength(1);
    });

    it("messageCount reflects added messages", async () => {
      const session = await makeSession();
      expect(session.messageCount).toBe(0);
      session.addUserMessage("one");
      expect(session.messageCount).toBe(1);
      session.appendAssistantTurn([{ type: "text", text: "two" }]);
      expect(session.messageCount).toBe(2);
    });

    it("getMessages returns all messages in order", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      session.appendAssistantTurn([{ type: "text", text: "assistant msg" }]);
      const msgs = session.getMessages();
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");
    });

    it("keeps diagnostics in full history but excludes them from provider history", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      const diagnostic: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "# Context Doctor" }],
        diagnosticOnly: true,
      };
      session.appendAssistantMessage(diagnostic);

      expect(session.getAllMessages()).toEqual([
        { role: "user", content: "user msg" },
        diagnostic,
      ]);
      expect(session.getMessages()).toEqual([
        { role: "user", content: "user msg" },
      ]);
    });

    it("keeps runtime errors in full history but excludes them from provider history", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      session.appendRuntimeError({
        message:
          "Codex API error: An error occurred while processing your request.",
        retryable: true,
      });

      expect(session.getAllMessages()).toHaveLength(2);
      expect(session.getAllMessages()[1]?.runtimeError).toEqual({
        message:
          "Codex API error: An error occurred while processing your request.",
        retryable: true,
      });

      const msgs = session.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({ role: "user", content: "user msg" });
    });

    it("dedupes consecutive identical runtime errors", async () => {
      const session = await makeSession();
      session.appendRuntimeError({ message: "same error", retryable: false });
      session.appendRuntimeError({ message: "same error", retryable: true });

      expect(session.getAllMessages()).toHaveLength(1);
      expect(session.getAllMessages()[0]?.runtimeError).toEqual({
        message: "same error",
        retryable: true,
      });
    });

    it("injects canonical resume context into provider history after a condense summary", async () => {
      const session = await makeSession();
      session.replaceMessages([
        { role: "user", content: "Fix issue" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "todo-before-condense",
              name: "todo_write",
              input: {
                todos: [
                  {
                    id: "fix",
                    content: "Fix the issue",
                    activeForm: "Fixing the issue",
                    status: "in_progress",
                  },
                ],
              },
            },
          ],
        },
        {
          role: "user",
          isSummary: true,
          condenseId: "condense-1",
          preservedContext: {
            toolNames: ["read_file"],
            mcpServerNames: ["linear"],
          },
          content: [
            {
              type: "text",
              text: '<system-reminder>\n## Resume Anchor (deterministic)\n- Latest user message: "Fix issue"\n- Continue from this task: "Fix issue"\n\n## Canonical User Messages (deterministic)\n1. "Fix issue"\n\n## Pending Tasks (deterministic heuristic)\n- Fix issue\n\n## Preserved Runtime Context (reattached outside transcript)\n### Available tool names\n- read_file\n\n### MCP servers with exposed tools\n- linear\n</system-reminder>',
            },
            { type: "text", text: "## Conversation Summary\n\nSummary body" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Need a bit more context." }],
        },
        { role: "user", content: "Continue fixing the issue." },
      ]);

      const msgs = session.getMessages();
      expect(msgs).toHaveLength(5);
      expect(msgs[0]).toEqual({ role: "user", content: "Fix issue" });
      expect(msgs[1]?.isSummary).toBe(true);
      expect(msgs[2]?.role).toBe("assistant");
      expect(msgs[3]?.role).toBe("user");
      expect(msgs[3]?.isResumeContext).toBe(true);
      expect(Array.isArray(msgs[3]?.content)).toBe(true);
      const injected = msgs[3]?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
      expect(injected[0]?.text).toContain(
        "### Current structured TODO state (authoritative)",
      );
      expect(injected[0]?.text).toContain('"content": "Fix the issue"');
      expect(injected[0]?.text).toContain('"status": "in_progress"');
      expect(msgs[4]).toEqual({
        role: "user",
        content: "Continue fixing the issue.",
      });
    });
  });

  describe("autoTitle", () => {
    it("sets title from first user message text", async () => {
      const session = await makeSession();
      session.addUserMessage("Fix the login bug");
      session.autoTitle();
      expect(session.title).toBe("Fix the login bug");
    });

    it("truncates long messages to 80 chars", async () => {
      const session = await makeSession();
      const longMsg = "x".repeat(100);
      session.addUserMessage(longMsg);
      session.autoTitle();
      expect(session.title).toHaveLength(80);
    });

    it("omits attachment markers from generated title", async () => {
      const session = await makeSession();
      session.addUserMessage(
        "Fix this regression\n[Attached: src/app.ts]\n[Attached: README.md]",
      );
      session.autoTitle();
      expect(session.title).toBe("Fix this regression");
    });

    it("omits injected file blocks and file contents from generated title", async () => {
      const session = await makeSession();
      session.addUserMessage(
        `<file path="src/secret.ts">\n\`\`\`ts\nconst token = "abc123";\n\`\`\`\n</file>\n\nSummarize the bug and propose a fix`,
      );
      session.autoTitle();
      expect(session.title).toBe("Summarize the bug and propose a fix");
    });

    it("keeps default title when sanitized text is empty", async () => {
      const session = await makeSession();
      session.addUserMessage(
        `<file path="src/only.ts">\n\`\`\`ts\nexport const x = 1;\n\`\`\`\n</file>`,
      );
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });

    it("does nothing when there are no messages", async () => {
      const session = await makeSession();
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });

    it("does nothing when first message has non-string content", async () => {
      const session = await makeSession();
      session.appendAssistantTurn([{ type: "text", text: "hello" }]);
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });
  });

  describe("token tracking", () => {
    it("starts at zero", async () => {
      const session = await makeSession();
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
    });

    it("accumulates across multiple calls", async () => {
      const session = await makeSession();
      session.addUsage(100, 50);
      session.addUsage(200, 75);
      expect(session.totalInputTokens).toBe(300);
      expect(session.totalOutputTokens).toBe(125);
    });

    it("lastInputTokens includes cache tokens for context window tracking", async () => {
      const session = await makeSession();
      // Simulate an API response where most tokens were cache reads:
      // input_tokens=50 (uncached), cache_read=9000, cache_creation=1000
      session.addUsage(50, 200, 9000, 1000);
      // lastInputTokens should be the TOTAL context window usage
      expect(session.lastInputTokens).toBe(50 + 9000 + 1000);
      // totalInputTokens accumulates just the raw API input_tokens (uncached)
      expect(session.totalInputTokens).toBe(50);
      expect(session.lastCacheReadTokens).toBe(9000);
    });

    it("tracks projected input separately from output-inclusive total usage", async () => {
      const session = await makeSession();
      session.addUsage(1000, 500, 200, 300);
      session.addEstimatedTokens(400);

      expect(session.estimatedInputUsed).toBe(1600);
      expect(session.estimatedTotalUsed).toBe(2100);
    });

    it("attributes estimated accumulation per source and resets on fresh usage", async () => {
      const session = await makeSession();
      // Clear the creation-time mode block estimate so the assertions below
      // cover only this test's contributions.
      session.addUsage(0, 0);
      session.addEstimatedTokens(400, "tool:read_file");
      session.addEstimatedTokens(800, "tool:read_file");
      session.addEstimatedTokens(400);

      // 4 chars ≈ 1 token
      expect(session.estimatedAccumulationBySource).toEqual({
        "tool:read_file": 300,
        other: 100,
      });
      expect(session.estimatedAccumulatedTokens).toBe(400);

      session.addUsage(1000, 500);
      expect(session.estimatedAccumulatedTokens).toBe(0);
      expect(session.estimatedAccumulationBySource).toEqual({});
    });

    it("tracks bounded per-tool-result byte and token attribution", async () => {
      const session = await makeSession();
      session.addUsage(0, 0);

      session.addToolResultContextAttribution(
        "call-1",
        "read_file",
        "é".repeat(400),
      );
      for (let index = 0; index < 64; index += 1) {
        session.addToolResultContextAttribution(
          `call-${index + 2}`,
          "search_files",
          "x".repeat(4),
        );
      }

      expect(session.toolResultContextAttributions).toHaveLength(64);
      expect(session.toolResultContextAttributions[0]).toEqual({
        toolCallId: "call-1",
        toolName: "read_file",
        chars: 400,
        bytes: 800,
        estimatedTokens: 100,
      });
      expect(session.omittedToolResultContextAttributions).toBe(1);
      expect(session.estimatedAccumulationBySource).toEqual({
        "tool:read_file": 100,
        "tool:search_files": 64,
      });

      session.addUsage(1_000, 500);
      expect(session.toolResultContextAttributions).toEqual([]);
      expect(session.omittedToolResultContextAttributions).toBe(0);
    });

    it("attributes user messages and attachments to the accumulator", async () => {
      const session = await makeSession();
      session.addUserMessage("x".repeat(400), {
        images: [{ name: "a.png", mimeType: "image/png", base64: "aaaa" }],
        documents: [
          {
            name: "d.pdf",
            mimeType: "application/pdf",
            base64: "b".repeat(4000),
          },
        ],
      });

      expect(session.estimatedAccumulationBySource["user_message"]).toBe(100);
      expect(session.estimatedAccumulationBySource["attachment:image"]).toBe(
        1_500,
      );
      // 4000 base64 chars → 3000 decoded bytes → 750 estimated tokens
      expect(session.estimatedAccumulationBySource["attachment:document"]).toBe(
        750,
      );
    });

    it("seeds a mode instruction anchor at creation and repins it on setMode", async () => {
      const session = await makeSession();
      expect(session.modeInstructionPlacement).toBe("conversation");
      expect(session.modeInstructionAnchors).toEqual([
        {
          userTurnOrdinal: 0,
          mode: "code",
          blockText: '<current_mode mode="code">mock block</current_mode>',
        },
      ]);

      // Switching with no new turns replaces the anchor instead of stacking.
      await session.setMode("architect");
      expect(session.modeInstructionAnchors).toEqual([
        {
          userTurnOrdinal: 0,
          mode: "architect",
          blockText: '<current_mode mode="architect">mock block</current_mode>',
        },
      ]);

      // After a turn, a switch pins a new anchor at the current boundary.
      session.addUserMessage("hello");
      session.appendAssistantTurn([{ type: "text", text: "hi" }]);
      await session.setMode("code");
      expect(session.modeInstructionAnchors).toHaveLength(2);
      expect(session.modeInstructionAnchors[1]).toMatchObject({
        userTurnOrdinal: 1,
        mode: "code",
      });
    });

    it("keeps background sessions on inline mode placement without anchors", async () => {
      const session = await makeSession({ background: true });
      expect(session.modeInstructionPlacement).toBe("system");
      expect(session.modeInstructionAnchors).toEqual([]);
      expect(session.buildModeInstructionInsertions([])).toEqual([]);
    });

    it("maps anchors to effective-history insertion points at turn boundaries", async () => {
      const session = await makeSession();
      session.addUserMessage("first");
      session.appendAssistantTurn([{ type: "text", text: "a" }]);
      await session.setMode("architect");
      session.addUserMessage("second");

      const effective = session.getMessages();
      expect(session.buildModeInstructionInsertions(effective)).toEqual([
        {
          beforeIndex: 0,
          blockText: '<current_mode mode="code">mock block</current_mode>',
        },
        {
          // Before the "second" user turn (index 2: first, assistant, second).
          beforeIndex: 2,
          blockText: '<current_mode mode="architect">mock block</current_mode>',
        },
      ]);
    });

    it("re-seeds a single top anchor when history is replaced", async () => {
      const session = await makeSession();
      session.addUserMessage("first");
      await session.setMode("architect");
      session.addUserMessage("second");
      expect(session.modeInstructionAnchors).toHaveLength(2);

      session.replaceMessages([{ role: "user", content: "condensed" }]);
      expect(session.modeInstructionAnchors).toEqual([
        {
          userTurnOrdinal: 0,
          mode: "architect",
          blockText: '<current_mode mode="architect">mock block</current_mode>',
        },
      ]);
    });

    it("restoreFromStore restores cache totals and last token snapshot", async () => {
      const session = await makeSession();
      session.restoreFromStore({
        id: "session-1",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheReadTokens: 300,
        totalCacheCreationTokens: 400,
        lastInputTokens: 500,
        lastCacheReadTokens: 600,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(session.totalInputTokens).toBe(100);
      expect(session.totalOutputTokens).toBe(200);
      expect(session.totalCacheReadTokens).toBe(300);
      expect(session.totalCacheCreationTokens).toBe(400);
      expect(session.lastInputTokens).toBe(500);
      expect(session.lastCacheReadTokens).toBe(600);
    });

    it("restoreFromStore defaults cache and last-token fields for older data", async () => {
      const session = await makeSession();
      session.restoreFromStore({
        id: "session-2",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(session.totalCacheReadTokens).toBe(0);
      expect(session.totalCacheCreationTokens).toBe(0);
      expect(session.lastInputTokens).toBe(0);
      expect(session.lastCacheReadTokens).toBe(0);
    });
  });

  describe("mode switching", () => {
    it("setMode updates mode metadata and preserves message history", async () => {
      const session = await makeSession({ mode: "code" });
      session.addUserMessage("keep this context");
      const priorMessageCount = session.messageCount;

      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("mock ask prompt"),
      );
      await session.setMode("ask");

      expect(session.mode).toBe("ask");
      expect(session.agentMode.slug).toBe("ask");
      expect(session.systemPrompt).toBe("mock ask prompt");
      expect(session.messageCount).toBe(priorMessageCount);
      expect(session.getMessages()[0]).toEqual({
        role: "user",
        content: "keep this context",
      });
    });

    it("setMode preserves pinned active-file context and its diagnostic", async () => {
      const activeFilePath = "/test/src/index.ts";
      const session = await makeSession({ activeFilePath });
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce({
        ...makePromptArtifacts("mock ask prompt"),
        activeFileContext: {
          status: "accepted",
          activeFilePath,
        },
      });

      await session.setMode("ask");

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ activeFilePath }),
      );
      expect(session.activeFileContext).toEqual({
        status: "accepted",
        activeFilePath,
      });
    });

    it("setMode passes stored providerId to buildPromptArtifacts", async () => {
      const session = await makeSession({ providerId: "codex" });
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("mock ask prompt"),
      );
      await session.setMode("ask");
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
    });

    it("setMode preserves disabled skill IDs", async () => {
      const disabledSkillIds = [
        "project:agentlink:.agentlink/skills/private-helper",
      ];
      const session = await makeSession({
        config: { ...testConfig, disabledSkillIds },
      });
      mockedBuildPromptArtifacts.mockClear();

      await session.setMode("ask");

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ disabledSkillIds }),
      );
    });

    it("setMode preserves background prompt identity", async () => {
      const session = await makeSession({
        background: true,
        isBackground: true,
      });
      mockedBuildPromptArtifacts.mockClear();

      await session.setMode("debug");

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "debug",
        "/test",
        expect.objectContaining({ isBackground: true }),
      );
    });
  });

  describe("updateModelSelection", () => {
    it("publishes a cross-provider selection after its prompt rebuild completes", async () => {
      const session = await makeSession({ providerId: "anthropic" });
      let resolveArtifacts!: (
        artifacts: ReturnType<typeof makePromptArtifacts>,
      ) => void;
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveArtifacts = resolve;
          }),
      );

      const update = session.updateModelSelection("codex-model", "codex");
      await Promise.resolve();

      expect(session.model).toBe(testConfig.model);
      expect(session.providerId).toBe("anthropic");
      expect(session.modelSelectionRevision).toBe(1);

      resolveArtifacts(makePromptArtifacts("codex prompt"));
      await update;
      await session.waitForModelSelectionUpdate();

      expect(session.model).toBe("codex-model");
      expect(session.providerId).toBe("codex");
      expect(session.systemPrompt).toBe("codex prompt");
    });
  });

  describe("rebuildSystemPrompt", () => {
    it("updates profile state and refreshes conversation mode instructions", async () => {
      const session = await makeSession({ providerId: "codex" });
      const reasoningProfile = {
        profile: "reasoning" as const,
        source: "exact-model-override" as const,
        policyRevision: "prompt-profile-policy-v1" as const,
        providerId: "codex",
        modelId: session.model,
      };
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("reasoning prompt", reasoningProfile),
      );
      mockedBuildModeInstructionBlock.mockClear();

      await session.rebuildSystemPrompt({
        promptProfileOverrides: { [session.model]: "reasoning" },
      });

      expect(session.promptProfile).toBe(reasoningProfile);
      expect(session.systemPrompt).toBe("reasoning prompt");
      expect(mockedBuildModeInstructionBlock).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ promptProfile: "reasoning" }),
      );
      expect(session.buildModeInstructionInsertions([])).toEqual([
        {
          beforeIndex: 0,
          blockText: expect.stringContaining('mode="code"'),
        },
      ]);
    });

    it("does not commit staged profile inputs when mode instruction construction fails", async () => {
      const session = await makeSession({
        providerId: "codex",
        config: {
          ...testConfig,
          disabledSkillIds: ["previous-skill"],
        },
      });
      const previousPrompt = session.systemPrompt;
      const previousProfile = session.promptProfile;
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("uncommitted prompt", {
          profile: "reasoning",
          source: "exact-model-override",
          policyRevision: "prompt-profile-policy-v1",
          providerId: "codex",
          modelId: session.model,
        }),
      );
      mockedBuildModeInstructionBlock.mockRejectedValueOnce(
        new Error("mode block failed"),
      );

      await expect(
        session.rebuildSystemPrompt({
          disabledSkillIds: ["replacement-skill"],
          promptProfileOverrides: { [session.model]: "reasoning" },
        }),
      ).rejects.toThrow("mode block failed");

      expect(session.systemPrompt).toBe(previousPrompt);
      expect(session.promptProfile).toBe(previousProfile);
      expect(session.disabledSkillIds).toEqual(["previous-skill"]);
    });

    it("passes stored providerId to buildPromptArtifacts", async () => {
      const session = await makeSession({ providerId: "codex" });
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("rebuilt prompt"),
      );
      await session.rebuildSystemPrompt();
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
      expect(session.systemPrompt).toBe("rebuilt prompt");
    });

    it("preserves background prompt identity", async () => {
      const session = await makeSession({
        background: true,
        isBackground: true,
      });
      mockedBuildPromptArtifacts.mockClear();

      await session.rebuildSystemPrompt();

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ isBackground: true }),
      );
    });

    it("updates and forwards disabled skill IDs on rebuild", async () => {
      const session = await makeSession({
        config: {
          ...testConfig,
          disabledSkillIds: [
            "project:agentlink:.agentlink/skills/previous-helper",
          ],
        },
      });
      const disabledSkillIds = [
        "project:agentlink:.agentlink/skills/private-helper",
      ];
      mockedBuildPromptArtifacts.mockClear();

      await session.rebuildSystemPrompt({ disabledSkillIds });

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ disabledSkillIds }),
      );
      expect(session.disabledSkillIds).toEqual(disabledSkillIds);
      expect(session.disabledSkillIds).not.toBe(disabledSkillIds);
    });

    it("forwards the Approve for Me flag on rebuild and mode switch", async () => {
      const session = await makeSession();
      mockedBuildPromptArtifacts.mockClear();
      await session.rebuildSystemPrompt();
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ approveForMe: false }),
      );

      session.approveForMe = true;
      mockedBuildPromptArtifacts.mockClear();
      await session.rebuildSystemPrompt();
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ approveForMe: true }),
      );

      mockedBuildPromptArtifacts.mockClear();
      await session.setMode("architect");
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "architect",
        "/test",
        expect.objectContaining({ approveForMe: true }),
      );
    });
  });

  describe("abort", () => {
    it("starts not aborted", async () => {
      const session = await makeSession();
      expect(session.isAborted).toBe(false);
    });

    it("abortSignal is undefined before createAbortController", async () => {
      const session = await makeSession();
      expect(session.abortSignal).toBeUndefined();
    });

    it("creates an AbortController and exposes the signal", async () => {
      const session = await makeSession();
      const ac = session.createAbortController();
      expect(ac).toBeInstanceOf(AbortController);
      expect(session.abortSignal).toBe(ac.signal);
      expect(session.isAborted).toBe(false);
    });

    it("abort() signals the controller", async () => {
      const session = await makeSession();
      session.createAbortController();
      expect(session.isAborted).toBe(false);
      session.abort();
      expect(session.isAborted).toBe(true);
    });

    it("isAborted is false after abort() when no controller was created", async () => {
      const session = await makeSession();
      session.abort(); // no-op
      expect(session.isAborted).toBe(false);
    });
  });

  describe("pending interjections", () => {
    it("accepts multiple interjections and consumes them FIFO", async () => {
      const session = await makeSession();
      expect(session.setPendingInterjection("first", "q1")).toBe(true);
      expect(session.setPendingInterjection("second", "q2")).toBe(true);
      expect(session.setPendingInterjection("third", "q3")).toBe(true);

      expect(session.consumePendingInterjection()?.text).toBe("first");
      expect(session.consumePendingInterjection()?.text).toBe("second");
      expect(session.consumePendingInterjection()?.text).toBe("third");
      expect(session.consumePendingInterjection()).toBeNull();
    });

    it("re-registering an existing queueId replaces the entry in place", async () => {
      const session = await makeSession();
      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("second", "q2");
      session.setPendingInterjection("first edited", "q1");

      const first = session.consumePendingInterjection();
      expect(first?.queueId).toBe("q1");
      expect(first?.text).toBe("first edited");
      expect(session.consumePendingInterjection()?.queueId).toBe("q2");
      expect(session.consumePendingInterjection()).toBeNull();
    });

    it("updatePendingInterjection edits only the matching entry", async () => {
      const session = await makeSession();
      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("second", "q2");

      expect(session.updatePendingInterjection("q2", { text: "edited" })).toBe(
        true,
      );
      expect(session.updatePendingInterjection("missing", { text: "x" })).toBe(
        false,
      );

      expect(session.consumePendingInterjection()?.text).toBe("first");
      expect(session.consumePendingInterjection()?.text).toBe("edited");
    });

    it("clearPendingInterjectionIf removes only the matching entry", async () => {
      const session = await makeSession();
      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("second", "q2");
      session.setPendingInterjection("third", "q3");

      expect(session.clearPendingInterjectionIf("q2")?.text).toBe("second");
      expect(session.clearPendingInterjectionIf("q2")).toBeNull();

      expect(session.consumePendingInterjection()?.queueId).toBe("q1");
      expect(session.consumePendingInterjection()?.queueId).toBe("q3");
      expect(session.consumePendingInterjection()).toBeNull();
    });

    it("hasPendingInterjections reflects the queue state", async () => {
      const session = await makeSession();
      expect(session.hasPendingInterjections).toBe(false);
      session.setPendingInterjection("first", "q1");
      expect(session.hasPendingInterjections).toBe(true);
      session.consumePendingInterjection();
      expect(session.hasPendingInterjections).toBe(false);
    });

    it("notifies queued listeners until they unsubscribe", async () => {
      const session = await makeSession();
      const seen: number[] = [];
      const unsubscribe = session.onPendingInterjectionQueued(() =>
        seen.push(seen.length + 1),
      );

      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("first edited", "q1");
      expect(seen).toEqual([1, 2]);

      unsubscribe();
      session.setPendingInterjection("second", "q2");
      expect(seen).toEqual([1, 2]);
    });
  });

  describe("queued UI messages", () => {
    it("tracks per-surface counts and clears on zero", async () => {
      const session = await makeSession();
      expect(session.hasQueuedUiMessages).toBe(false);

      session.setQueuedUiMessageCount("vscode", 2);
      expect(session.hasQueuedUiMessages).toBe(true);

      session.setQueuedUiMessageCount("browser", 1);
      session.setQueuedUiMessageCount("vscode", 0);
      expect(session.hasQueuedUiMessages).toBe(true);

      session.setQueuedUiMessageCount("browser", 0);
      expect(session.hasQueuedUiMessages).toBe(false);
    });
  });
});
