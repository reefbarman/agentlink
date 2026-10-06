import {
  createExplicitSkillAdmission,
  verifyPreparedSkillSelections,
} from "./explicitSkillSelection.js";
import { describe, expect, it, vi } from "vitest";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { HookRuntime } from "../core/hooks/HookRuntime.js";
import type { SkillEntry } from "./skillLoader.js";
import { createHash } from "node:crypto";
import path from "node:path";

const skillPath = "/workspace/.agentlink/skills/review/SKILL.md";
const content = "Review changes carefully.";
const revision = createHash("sha256").update(content).digest("hex");
const selection = {
  skillId: "project:agentlink:.agentlink/skills/review",
  skillRevision: revision,
};

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  const skillDirectory = path.dirname(skillPath);
  return {
    id: selection.skillId,
    name: "review",
    description: "Review changes",
    revision,
    sourceChars: content.length,
    provenance: {
      scope: "project",
      namespace: "agentlink",
      sourceRoot: path.dirname(skillDirectory),
      skillDirectory,
      realSkillPath: skillPath,
      priority: 1,
    },
    skillPath,
    restrictions: { allowedTools: ["read_file"] },
    permissions: { requestedTools: [] },
    dependencies: [],
    recommendations: [],
    resolvedDependencies: [],
    enabled: true,
    ...overrides,
  } as SkillEntry;
}

function makeProvider(readTextFile = vi.fn(async () => content)) {
  const provider: AdvertisedArtifactProvider = {
    resolvePath: (value) => path.resolve(value),
    normalizeExistingPath: (value) => path.normalize(value),
    readTextFile,
  };
  return { provider, readTextFile };
}

function hookRuntime(overrides: Record<string, unknown> = {}) {
  return {
    userPromptSubmit: vi.fn(async () => ({
      additionalContext: [],
      block: undefined,
    })),
    preToolUse: vi.fn(async () => ({
      additionalContext: [],
      preToolUse: undefined,
    })),
    postToolUse: vi.fn(async () => ({
      additionalContext: [],
      feedback: [],
      block: undefined,
    })),
    ...overrides,
  } as unknown as HookRuntime & {
    userPromptSubmit: ReturnType<typeof vi.fn>;
    preToolUse: ReturnType<typeof vi.fn>;
    postToolUse: ReturnType<typeof vi.fn>;
  };
}

const hookBase = () => ({
  session_id: "session-test",
  turn_id: "turn-test",
  cwd: "/workspace",
  model: "test-model",
});

describe("createExplicitSkillAdmission", () => {
  it("rejects unavailable, disabled, stale, and unreadable selections before preparing context", async () => {
    const cases: Array<{
      name: string;
      skills: SkillEntry[];
      provider?: AdvertisedArtifactProvider;
      code: string;
    }> = [
      { name: "missing", skills: [], code: "skill_selection_unavailable" },
      {
        name: "disabled",
        skills: [makeSkill({ enabled: false })],
        code: "skill_selection_unavailable",
      },
      {
        name: "stale revision",
        skills: [makeSkill({ revision: "new-revision" })],
        code: "skill_selection_stale",
      },
      {
        name: "unreadable file",
        skills: [makeSkill()],
        provider: makeProvider(
          vi.fn(async () => {
            throw new Error("read denied");
          }),
        ).provider,
        code: "skill_selection_unreadable",
      },
    ];

    for (const testCase of cases) {
      const admission = createExplicitSkillAdmission({
        getAdvertisedSkills: () => testCase.skills,
        artifactProvider: testCase.provider ?? makeProvider().provider,
      });
      await expect(
        admission.prepareBatch([{ text: "inspect", selection }]),
        testCase.name,
      ).rejects.toMatchObject({ failure: { code: testCase.code } });
    }
  });

  it("rejects hook denial and any rewritten canonical skill path", async () => {
    const denial = hookRuntime({
      preToolUse: vi.fn(async () => ({
        additionalContext: [],
        preToolUse: { decision: "deny", reason: "blocked by policy" },
      })),
    });
    const deniedAdmission = createExplicitSkillAdmission({
      getAdvertisedSkills: () => [makeSkill()],
      artifactProvider: makeProvider().provider,
      hookRuntime: denial,
      hookBase,
    });
    await expect(
      deniedAdmission.prepareBatch([{ text: "inspect", selection }]),
    ).rejects.toMatchObject({
      failure: { code: "skill_selection_hook_denied" },
    });

    const substitution = hookRuntime({
      preToolUse: vi.fn(async () => ({
        additionalContext: [],
        preToolUse: { updatedInput: { path: "/workspace/other/SKILL.md" } },
      })),
    });
    const substitutedAdmission = createExplicitSkillAdmission({
      getAdvertisedSkills: () => [makeSkill()],
      artifactProvider: makeProvider().provider,
      hookRuntime: substitution,
      hookBase,
    });
    await expect(
      substitutedAdmission.prepareBatch([{ text: "inspect", selection }]),
    ).rejects.toMatchObject({ failure: { code: "skill_selection_conflict" } });
  });

  it("submits a deterministic marker for selection-only input, without skill content", async () => {
    const hooks = hookRuntime();
    const admission = createExplicitSkillAdmission({
      getAdvertisedSkills: () => [makeSkill()],
      artifactProvider: makeProvider().provider,
      hookRuntime: hooks,
      hookBase,
    });

    const [prepared] = await admission.prepareBatch([
      { text: "", selection, runUserPromptSubmit: true },
    ]);

    expect(hooks.userPromptSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        hook_event_name: "UserPromptSubmit",
        prompt: "[Selected skill: review]",
      }),
      undefined,
    );
    expect(prepared?.prepared?.context.content).toBe(content);
    expect(hooks.preToolUse).toHaveBeenCalledOnce();
    expect(hooks.postToolUse).toHaveBeenCalledOnce();
  });

  it("rejects a whole batch when the staged skill context exceeds its token bound", async () => {
    const admission = createExplicitSkillAdmission({
      getAdvertisedSkills: () => [makeSkill()],
      artifactProvider: makeProvider().provider,
      maxSkillContextTokens: () => 1,
    });

    await expect(
      admission.prepareBatch([
        { text: "first", selection },
        { text: "second" },
      ]),
    ).rejects.toMatchObject({ failure: { code: "skill_selection_too_large" } });
  });

  it("fails the final synchronous check when the catalogue changes during staging", async () => {
    let skills = [makeSkill()];
    const admission = createExplicitSkillAdmission({
      getAdvertisedSkills: () => skills,
      artifactProvider: makeProvider().provider,
    });
    const [prepared] = await admission.prepareBatch([
      { text: "inspect", selection },
    ]);
    skills = [makeSkill({ revision: "changed" })];

    expect(
      verifyPreparedSkillSelections(skills, [prepared?.prepared]),
    ).toMatchObject({
      code: "skill_selection_stale",
    });
  });
});
