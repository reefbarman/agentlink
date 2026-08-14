import { describe, expect, it, vi } from "vitest";

import { createHash } from "crypto";
import { handleLoadSkill } from "./loadSkill.js";

function textOf(result: Awaited<ReturnType<typeof handleLoadSkill>>): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("handleLoadSkill", () => {
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
      skill_name: "helper",
      skillPath: "/provider/skills/helper/SKILL.md",
      skill_id: "global:agentlink:helper",
      revision,
      content,
    });
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

  it("loads resources from an advertised built-in skill directory", async () => {
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

    const result = await handleLoadSkill(
      {
        path: "/extensions/agentlink/resources/builtin-skills/documentation/references/complete-reference.md",
      },
      {} as never,
      {} as never,
      "session-1",
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

    expect(artifactProvider.readTextFile).toHaveBeenNthCalledWith(
      1,
      "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md",
    );
    expect(artifactProvider.readTextFile).toHaveBeenNthCalledWith(
      2,
      "/extensions/agentlink/resources/builtin-skills/documentation/references/complete-reference.md",
    );
    expect(JSON.parse(textOf(result))).toEqual({
      skill_name: "documentation",
      skillPath:
        "/extensions/agentlink/resources/builtin-skills/documentation/SKILL.md",
      skill_id: "builtin:agentlink:documentation",
      revision,
      resourcePath:
        "/extensions/agentlink/resources/builtin-skills/documentation/references/complete-reference.md",
      content: resourceContent,
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
