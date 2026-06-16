import { describe, expect, it, vi } from "vitest";

import { handleLoadSkill } from "./loadSkill.js";

function textOf(result: Awaited<ReturnType<typeof handleLoadSkill>>): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("handleLoadSkill", () => {
  it("loads advertised skill files through an artifact provider", async () => {
    const artifactProvider = {
      resolvePath: vi.fn(() => "/provider/skills/helper/SKILL.md"),
      normalizeExistingPath: vi.fn((filePath: string) => filePath),
      readTextFile: vi.fn(async () => "# Helper skill\nUse helper workflow."),
    };

    const result = await handleLoadSkill(
      { path: "/provider/skills/helper/SKILL.md" },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          name: "helper",
          skillPath: "/provider/skills/helper/SKILL.md",
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
      content: "# Helper skill\nUse helper workflow.",
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
