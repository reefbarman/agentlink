import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { AllowedSkill } from "./loadSkill.js";
import { createHash } from "crypto";
import { handleReadSkillResource } from "./readSkillResource.js";

const provider: AdvertisedArtifactProvider = {
  resolvePath: (input) => path.resolve(input),
  normalizeExistingPath: (filePath) => {
    try {
      return path.normalize(fs.realpathSync(filePath));
    } catch {
      return path.normalize(path.resolve(filePath));
    }
  },
  readTextFile: (filePath) => fsp.readFile(filePath, "utf-8"),
};

function parse(result: Awaited<ReturnType<typeof handleReadSkillResource>>) {
  return JSON.parse(
    result.content.find((item) => item.type === "text")?.text ?? "{}",
  ) as Record<string, unknown>;
}

describe("handleReadSkillResource", () => {
  let root: string;
  let skillDir: string;
  let skill: AllowedSkill;

  beforeEach(async () => {
    root = fs.realpathSync(
      await fsp.mkdtemp(path.join(os.tmpdir(), "skill-resource-")),
    );
    skillDir = path.join(root, "builtin-skills", "documentation");
    await fsp.mkdir(path.join(skillDir, "references"), { recursive: true });
    const skillContent = "# Documentation\nSee references/tools.md.";
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), skillContent);
    await fsp.writeFile(
      path.join(skillDir, "references", "tools.md"),
      "line 1\nline 2\nline 3\n",
    );
    await fsp.writeFile(path.join(root, "outside.md"), "secret");
    skill = {
      id: "builtin:agentlink:documentation",
      name: "documentation",
      revision: createHash("sha256").update(skillContent).digest("hex"),
      skillPath: path.join(skillDir, "SKILL.md"),
      realSkillPath: path.join(skillDir, "SKILL.md"),
      sourceScope: "builtin",
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("reads a built-in resource without activation fields implying a load", async () => {
    const result = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: "references/tools.md" },
      [skill],
      provider,
    );

    expect(result.isError).toBe(false);
    expect(parse(result)).toMatchObject({
      kind: "skill_resource",
      activation: false,
      skill_id: skill.id,
      resource_path: "references/tools.md",
      resourcePath: path.join(skillDir, "references", "tools.md"),
      total_lines: 3,
      showing: "1-3",
      eof: true,
      content: "line 1\nline 2\nline 3",
    });
  });

  it("paginates with offset, limit and next_offset", async () => {
    const result = await handleReadSkillResource(
      {
        skill_path: skill.skillPath,
        resource_path: "./references/tools.md",
        offset: 2,
        limit: 1,
      },
      [skill],
      provider,
    );

    expect(parse(result)).toMatchObject({
      showing: "2-2",
      eof: false,
      next_offset: 3,
      content: "line 2",
    });
  });

  it.each([
    ["../outside.md", "invalid_resource_path"],
    ["references/../../outside.md", "invalid_resource_path"],
    ["/etc/passwd", "invalid_resource_path"],
    ["", "invalid_resource_path"],
    ["SKILL.md", "invalid_resource_path"],
    ["references", "resource_is_directory"],
    ["references/missing.md", "resource_not_found"],
  ])("rejects %s with %s", async (resourcePath, status) => {
    const result = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: resourcePath },
      [skill],
      provider,
    );
    expect(result.isError).toBe(true);
    expect(parse(result).status).toBe(status);
  });

  it("rejects symlinks that escape the skill directory", async () => {
    await fsp.symlink(
      path.join(root, "outside.md"),
      path.join(skillDir, "references", "escape.md"),
    );
    const result = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: "references/escape.md" },
      [skill],
      provider,
    );
    expect(result.isError).toBe(true);
    expect(parse(result).status).toBe("resource_outside_skill");
  });

  it("rejects binary resources", async () => {
    await fsp.writeFile(
      path.join(skillDir, "references", "image.bin"),
      Buffer.from([0x89, 0x00, 0x01]),
    );
    const result = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: "references/image.bin" },
      [skill],
      provider,
    );
    expect(parse(result).status).toBe("binary_resource");
  });

  it("rejects unadvertised owners and non-built-in skills", async () => {
    const unadvertised = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: "references/tools.md" },
      [],
      provider,
    );
    expect(parse(unadvertised).status).toBe("skill_not_in_catalog");

    const project = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: "references/tools.md" },
      [{ ...skill, sourceScope: "project" }],
      provider,
    );
    expect(parse(project)).toMatchObject({
      status: "unsupported_skill_scope",
      guidance: expect.stringContaining("read_file"),
    });
  });

  it("fails closed when the owner changed after advertisement", async () => {
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "# Changed");
    const result = await handleReadSkillResource(
      { skill_path: skill.skillPath, resource_path: "references/tools.md" },
      [skill],
      provider,
    );
    expect(parse(result).status).toBe("stale_advertised_artifact");
  });
});
