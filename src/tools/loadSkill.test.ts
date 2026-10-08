import { describe, expect, it, vi } from "vitest";
import { handleLoadSkill, loadSkill } from "./loadSkill.js";

import { createHash } from "crypto";

function textOf(result: Awaited<ReturnType<typeof handleLoadSkill>>): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("handleLoadSkill", () => {
  it("returns only exact discovery diagnostics without reading or activating excluded skills", async () => {
    const skillPath = "/workspace/.agents/skills/pull-request/SKILL.md";
    const provider = {
      resolveLexicalPath: (input: string) => `/workspace/${input}`,
      resolvePath: vi.fn((input: string) =>
        input.startsWith("/") ? input : `/workspace/${input}`,
      ),
      normalizeExistingPath: vi.fn((input: string) => input),
      readTextFile: vi.fn(async () => "must not be read"),
    };
    const diagnostics = [
      {
        code: "invalid-metadata",
        severity: "error" as const,
        sourcePath: skillPath,
        message: "frontmatter field 'name' is required",
      },
      {
        code: "invalid-metadata",
        severity: "error" as const,
        sourcePath: "/workspace/.agents/skills/other/SKILL.md",
        message: "unrelated diagnostic",
      },
    ];
    const outcome = await loadSkill(
      { path: ".agents/skills/pull-request/SKILL.md" },
      [],
      provider,
      diagnostics,
    );
    expect(outcome.activation).toBeUndefined();
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.data).toMatchObject({
      status: "skill_not_in_catalog",
      diagnostics: [
        {
          code: "invalid-metadata",
          severity: "error",
          message: "frontmatter field 'name' is required",
        },
      ],
      guidance: expect.stringContaining("no file access has been granted"),
    });
    expect(provider.readTextFile).not.toHaveBeenCalled();
    expect(textOf(outcome.result)).not.toContain("unrelated diagnostic");
  });

  it.each([
    "/elsewhere/pull-request/SKILL.md",
    "/workspace/.agents/skills/pull-request/guide.md",
    "pull-request",
    ".agents/skills/pull-request/SKILL.md",
    "/alias/SKILL.md",
  ])(
    "does not disclose diagnostics for an undiscovered path or alias: %s",
    async (requested) => {
      const skillPath = "/workspace/.agents/skills/pull-request/SKILL.md";
      const provider = {
        resolvePath: (input: string) =>
          input === "/alias/SKILL.md" ? skillPath : input,
        normalizeExistingPath: (input: string) =>
          input === "/alias/SKILL.md" ? skillPath : input,
        readTextFile: vi.fn(async () => "must not be read"),
      };
      const outcome = await loadSkill({ path: requested }, [], provider, [
        {
          code: "invalid-metadata",
          severity: "error",
          sourcePath: skillPath,
          message: "hidden diagnostic",
        },
      ]);
      expect(outcome.activation).toBeUndefined();
      expect(outcome.result.data).not.toHaveProperty("diagnostics");
      expect(textOf(outcome.result)).not.toContain("hidden diagnostic");
      expect(provider.readTextFile).not.toHaveBeenCalled();
    },
  );

  it("bounds exact-path diagnostic output", async () => {
    const skillPath = "/workspace/broken/SKILL.md";
    const provider = {
      resolvePath: (input: string) => input,
      normalizeExistingPath: (input: string) => input,
      readTextFile: vi.fn(async () => "must not be read"),
    };
    const outcome = await loadSkill(
      { path: skillPath },
      [],
      provider,
      Array.from({ length: 12 }, () => ({
        code: "invalid-metadata",
        severity: "error" as const,
        sourcePath: skillPath,
        message: "x".repeat(2000),
      })),
    );
    const data = outcome.result.data as {
      diagnostics: Array<{ message: string }>;
    };
    expect(data.diagnostics).toHaveLength(8);
    expect(data.diagnostics.every((item) => item.message.length === 1000)).toBe(
      true,
    );
    expect(provider.readTextFile).not.toHaveBeenCalled();
  });

  it("loads advertised skill files through an artifact provider", async () => {
    const content = "# Helper skill\nUse helper workflow.";
    const revision = createHash("sha256").update(content).digest("hex");
    const artifactProvider = {
      resolvePath: vi.fn(() => "/provider/skills/helper/SKILL.md"),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async () => content),
    };

    const result = await handleLoadSkill(
      { path: "/provider/skills/helper/SKILL.md" },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          id: "global:agentlink:helper",
          name: "helper",
          revision,
          skillPath: "/provider/skills/helper/SKILL.md",
          realSkillPath: "/provider/skills/helper/SKILL.md",
          sourceScope: "global",
        },
      ],
      artifactProvider,
    );

    expect(artifactProvider.resolvePath).toHaveBeenCalledWith(
      "/provider/skills/helper/SKILL.md",
    );
    expect(artifactProvider.readTextFile).toHaveBeenCalledWith(
      "/provider/skills/helper/SKILL.md",
    );
    expect(JSON.parse(textOf(result))).toEqual({
      kind: "skill_activation",
      skill_name: "helper",
      skillPath: "/provider/skills/helper/SKILL.md",
      skillDirectory: "/provider/skills/helper",
      skill_id: "global:agentlink:helper",
      revision,
      resourceGuidance: expect.stringContaining("read_file"),
      content,
    });
  });

  it("returns a typed activation only for a successful SKILL.md load", async () => {
    const content = "# Helper skill";
    const revision = createHash("sha256").update(content).digest("hex");
    const skill = {
      id: "global:agentlink:helper",
      name: "helper",
      revision,
      skillPath: "/provider/skills/helper/SKILL.md",
      realSkillPath: "/provider/skills/helper/SKILL.md",
      sourceScope: "global" as const,
    };
    const provider = {
      resolvePath: vi.fn((input: string) => input),
      normalizeExistingPath: vi.fn((input: string) => input),
      readTextFile: vi.fn(async () => content),
    };

    const loaded = await loadSkill(
      { path: skill.skillPath },
      [skill],
      provider,
    );
    expect(loaded.activation).toEqual({
      id: skill.id,
      name: skill.name,
      revision,
      skillPath: skill.skillPath,
    });

    const rejected = await loadSkill(
      { path: "/provider/skills/other/SKILL.md" },
      [skill],
      provider,
    );
    expect(rejected.result.isError).toBe(true);
    expect(rejected.activation).toBeUndefined();
  });

  it("returns the canonical activation path when loading an advertised symlink alias", async () => {
    const content = "# Helper skill";
    const canonicalPath = "/provider/.agents/skills/helper/SKILL.md";
    const aliasPath = "/provider/.agentlink/skills/helper/SKILL.md";
    const realPath = "/provider/shared/helper/SKILL.md";
    const provider = {
      resolvePath: vi.fn((input: string) => input),
      normalizeExistingPath: vi.fn((input: string) =>
        input === canonicalPath || input === aliasPath ? realPath : input,
      ),
      readTextFile: vi.fn(async () => content),
    };
    const result = await handleLoadSkill(
      { path: aliasPath },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          id: "project:agents:helper",
          name: "helper",
          revision: createHash("sha256").update(content).digest("hex"),
          skillPath: canonicalPath,
          realSkillPath: realPath,
          sourceScope: "project",
        },
      ],
      provider,
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({
      skillPath: canonicalPath,
      skill_id: "project:agents:helper",
    });
  });

  it("returns bounded canonical candidates without reading or activating an unadvertised path", async () => {
    const skills = Array.from({ length: 12 }, (_, index) => ({
      id: `project:agents:helper-${index}`,
      name: "helper",
      revision: "a".repeat(64),
      skillPath: `/provider/${index}/helper/SKILL.md`,
      realSkillPath: `/provider/${index}/helper/SKILL.md`,
      sourceScope: "project" as const,
    }));
    const provider = {
      resolvePath: vi.fn((input: string) => input),
      normalizeExistingPath: vi.fn((input: string) => input),
      readTextFile: vi.fn(),
    };
    const result = await handleLoadSkill(
      { path: "/unadvertised/helper/SKILL.md" },
      {} as never,
      {} as never,
      "session-1",
      skills,
      provider,
    );
    expect(result.isError).toBe(true);
    expect(provider.readTextFile).not.toHaveBeenCalled();
    const data = JSON.parse(textOf(result));
    expect(data.status).toBe("skill_not_in_catalog");
    expect(data.candidates).toHaveLength(10);
    expect(data.omittedCandidates).toBe(2);
    expect(data.candidates[0].path).toBe(skills[0].skillPath);
  });

  it("rejects skill content changed after advertisement", async () => {
    const advertisedContent = "# Helper skill\nOriginal workflow.";
    const artifactProvider = {
      resolvePath: vi.fn(() => "/provider/skills/helper/SKILL.md"),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async () => "# Helper skill\nChanged workflow."),
    };

    const result = await handleLoadSkill(
      { path: "/provider/skills/helper/SKILL.md" },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          id: "global:agentlink:helper",
          name: "helper",
          revision: createHash("sha256")
            .update(advertisedContent)
            .digest("hex"),
          skillPath: "/provider/skills/helper/SKILL.md",
          realSkillPath: "/provider/skills/helper/SKILL.md",
          sourceScope: "global",
        },
      ],
      artifactProvider,
    );

    expect(JSON.parse(textOf(result))).toMatchObject({
      error: expect.stringContaining("changed after it was advertised"),
      status: "stale_advertised_artifact",
    });
  });

  it("rejects skill targets changed after advertisement", async () => {
    const content = "# Helper skill\nUse helper workflow.";
    const artifactProvider = {
      resolvePath: vi.fn(() => "/provider/skills/helper/SKILL.md"),
      normalizeExistingPath: vi.fn((filePath: string) =>
        filePath === "/provider/skills/helper/SKILL.md"
          ? "/provider/skills/replaced/SKILL.md"
          : filePath,
      ),
      readTextFile: vi.fn(async () => content),
    };

    const result = await handleLoadSkill(
      { path: "/provider/skills/helper/SKILL.md" },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          id: "global:agentlink:helper",
          name: "helper",
          revision: createHash("sha256").update(content).digest("hex"),
          skillPath: "/provider/skills/helper/SKILL.md",
          realSkillPath: "/provider/skills/original/SKILL.md",
          sourceScope: "global",
        },
      ],
      artifactProvider,
    );

    expect(artifactProvider.readTextFile).not.toHaveBeenCalled();
    expect(JSON.parse(textOf(result))).toMatchObject({
      error: expect.stringContaining("changed after it was advertised"),
      status: "stale_advertised_artifact",
    });
  });

  it("activates a built-in skill through its SKILL.md with read_skill_resource guidance", async () => {
    const skillContent = "# Built-in documentation";
    const revision = createHash("sha256").update(skillContent).digest("hex");
    const skillPath =
      "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md";
    const artifactProvider = {
      resolvePath: vi.fn((filePath: string) => filePath),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async () => skillContent),
    };

    const loaded = await loadSkill(
      { path: skillPath },
      [
        {
          id: "builtin:agentlink:documentation",
          name: "documentation",
          revision,
          skillPath,
          realSkillPath: skillPath,
          sourceScope: "builtin",
        },
      ],
      artifactProvider,
    );

    expect(loaded.activation?.id).toBe("builtin:agentlink:documentation");
    expect(JSON.parse(textOf(loaded.result))).toMatchObject({
      kind: "skill_activation",
      skillDirectory:
        "/extensions/agentlink/resources/builtin-skills/documentation",
      resourceGuidance: expect.stringContaining("read_skill_resource"),
      content: skillContent,
    });
  });

  it("reads legacy built-in resource paths without activating the owner", async () => {
    const skillContent = "# Built-in documentation";
    const resourceContent = "# Complete reference\nBundled documentation.";
    const revision = createHash("sha256").update(skillContent).digest("hex");
    const artifactProvider = {
      resolvePath: vi.fn((filePath: string) => filePath),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async (filePath: string) =>
        filePath.endsWith("SKILL.md") ? skillContent : resourceContent,
      ),
    };

    const { result, activation } = await loadSkill(
      {
        path: "/extensions/agentlink/resources/builtin-skills/documentation/references/complete-reference.md",
      },
      [
        {
          id: "builtin:agentlink:documentation",
          name: "documentation",
          revision,
          skillPath:
            "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md",
          realSkillPath:
            "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md",
          sourceScope: "builtin",
        },
      ],
      artifactProvider,
    );

    expect(activation).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(artifactProvider.readTextFile).toHaveBeenNthCalledWith(
      1,
      "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md",
    );
    expect(artifactProvider.readTextFile).toHaveBeenNthCalledWith(
      2,
      "/extensions/agentlink/resources/builtin-skills/documentation/references/complete-reference.md",
    );
    expect(JSON.parse(textOf(result))).toEqual({
      kind: "skill_resource",
      activation: false,
      skill_name: "documentation",
      skillPath:
        "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md",
      skill_id: "builtin:agentlink:documentation",
      revision,
      resource_path: "references/complete-reference.md",
      resourcePath:
        "/extensions/agentlink/resources/builtin-skills/documentation/references/complete-reference.md",
      content: resourceContent,
      deprecation: expect.stringContaining("read_skill_resource"),
    });
  });

  it("does not load resources from an advertised non-built-in skill", async () => {
    const skillContent = "# Global helper";
    const revision = createHash("sha256").update(skillContent).digest("hex");
    const artifactProvider = {
      resolvePath: vi.fn((filePath: string) => filePath),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async () => skillContent),
    };

    const result = await handleLoadSkill(
      { path: "/provider/skills/helper/references/guide.md" },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          id: "global:agentlink:helper",
          name: "helper",
          revision,
          skillPath: "/provider/skills/helper/SKILL.md",
          realSkillPath: "/provider/skills/helper/SKILL.md",
          sourceScope: "global",
        },
      ],
      artifactProvider,
    );

    expect(artifactProvider.readTextFile).not.toHaveBeenCalled();
    expect(JSON.parse(textOf(result))).toMatchObject({
      error:
        "Skill path is not in the current session's advertised skill allowlist",
      path: "/provider/skills/helper/references/guide.md",
      status: "skill_not_in_catalog",
      guidance: expect.stringContaining(
        "supporting file inside the helper skill directory",
      ),
    });
  });

  it("rejects paths outside the advertised skill allowlist", async () => {
    const artifactProvider = {
      resolvePath: vi.fn(() => "/provider/skills/other/SKILL.md"),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async () => "# Other"),
    };

    const result = await handleLoadSkill(
      { path: "/provider/skills/other/SKILL.md" },
      {} as never,
      {} as never,
      "session-1",
      [],
      artifactProvider,
    );

    expect(artifactProvider.readTextFile).not.toHaveBeenCalled();
    expect(JSON.parse(textOf(result))).toMatchObject({
      error:
        "Skill path is not in the current session's advertised skill allowlist",
      path: "/provider/skills/other/SKILL.md",
    });
  });
});
