import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills, parseFrontmatter } from "./skillLoader.js";

let tmpDir: string;
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  body = "# Skill\n\nInstructions.",
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = path.join(dir, "SKILL.md");
  fs.writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n${body}`);
  return skillPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-skill-test-"));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-skill-home-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("parses scalars, bracket lists, and block lists without splitting prose commas", () => {
    const parsed = parseFrontmatter(`---
name: review-helper
description: Review helper
modeSlugs: code, review
allowed-tools:
  - read_file
  - search_files
quoted: "hello"
inline: [get_context, go_to_definition]
---
# Body`);

    expect(parsed).toMatchObject({
      name: "review-helper",
      description: "Review helper",
      modeSlugs: "code, review",
      "allowed-tools": ["read_file", "search_files"],
      quoted: "hello",
      inline: ["get_context", "go_to_definition"],
    });
  });
});

describe("loadSkills", () => {
  it("loads allowed-tools, modeSlugs, and invocation metadata from SKILL.md frontmatter", async () => {
    const skillPath = writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "readonly-review",
      [
        "name: readonly-review",
        "description: Read-only review",
        "modeSlugs: code",
        "invocation: manual",
        "allowed-tools:",
        "  - read_file",
        "  - search_files",
      ].join("\n"),
    );

    const skills = await loadSkills(tmpDir, "code");
    expect(skills).toEqual(
      expect.arrayContaining([
        {
          name: "readonly-review",
          description: "Read-only review",
          skillPath,
          allowedTools: ["read_file", "search_files"],
          invocation: "manual",
        },
      ]),
    );
  });

  it("filters mode-incompatible skills without masking lower-priority compatible skills", async () => {
    writeSkill(
      path.join(tmpDir, ".agents", "skills"),
      "helper",
      "name: helper\ndescription: lower\nmodeSlugs: code",
    );
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "helper",
      "name: helper\ndescription: higher incompatible\nmodeSlugs: review",
    );

    const skills = await loadSkills(tmpDir, "code");
    expect(skills.find((skill) => skill.name === "helper")?.description).toBe(
      "lower",
    );
  });
});
