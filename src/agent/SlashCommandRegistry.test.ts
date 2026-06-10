import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SlashCommandRegistry } from "./SlashCommandRegistry.js";

let tmpDir: string;
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function writeSkill(root: string, name: string, frontmatter: string): string {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, `---\n${frontmatter}\n---\n# ${name}\n`);
  return skillPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-slash-test-"));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-slash-home-"));
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

describe("SlashCommandRegistry", () => {
  it("exposes /remember as a prompt command", async () => {
    const registry = new SlashCommandRegistry(tmpDir, "code");
    await registry.reload();

    const command = registry.getAll().find((cmd) => cmd.name === "remember");
    expect(command).toMatchObject({
      source: "builtin",
      builtin: false,
    });
    expect(command?.body).toContain("propose_memory");
    expect(command?.body).toContain("highest appropriate tier");
  });

  it("exposes bundled skills as slash commands", async () => {
    const registry = new SlashCommandRegistry(tmpDir, "code");
    await registry.reload();

    const command = registry
      .getAll()
      .find((cmd) => cmd.name === "skill:skill-writing");
    expect(command).toMatchObject({
      source: "skill",
      builtin: false,
    });
    expect(command?.description).toContain("Agent Skills");
    expect(command?.skillPath).toContain(
      path.join("resources", "builtin-skills", "skill-writing", "SKILL.md"),
    );
    expect(command?.body).toContain("load_skill");
  });

  it("exposes detected skills as slash commands", async () => {
    const skillPath = writeSkill(
      path.join(tmpDir, ".agents", "skills"),
      "capture-smoke",
      "name: capture-smoke\ndescription: Capture smoke test",
    );

    const registry = new SlashCommandRegistry(tmpDir, "code");
    await registry.reload();

    const command = registry
      .getAll()
      .find((cmd) => cmd.name === "skill:capture-smoke");
    expect(command).toMatchObject({
      description: "Capture smoke test",
      source: "skill",
      builtin: false,
      skillPath,
    });
    expect(command?.body).toContain("load_skill");
    expect(command?.body).toContain(JSON.stringify(skillPath));
  });

  it("lets explicit slash commands override generated skill commands", async () => {
    writeSkill(
      path.join(tmpDir, ".agents", "skills"),
      "capture-smoke",
      "name: capture-smoke\ndescription: Skill command",
    );
    const commandDir = path.join(tmpDir, ".agentlink", "commands", "skill");
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandDir, "capture-smoke.md"),
      "---\ndescription: Explicit command\n---\nexplicit body",
    );

    const registry = new SlashCommandRegistry(tmpDir, "code");
    await registry.reload();

    const command = registry
      .getAll()
      .find((cmd) => cmd.name === "skill:capture-smoke");
    expect(command).toMatchObject({
      description: "Explicit command",
      source: "agentlink",
      body: "explicit body",
    });
    expect(command?.skillPath).toBeUndefined();
  });

  it("filters skill slash commands by active mode", async () => {
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "code-only",
      "name: code-only\ndescription: Code only\nmodeSlugs: code",
    );

    const registry = new SlashCommandRegistry(tmpDir, "ask");
    await registry.reload();
    expect(
      registry.getAll().some((cmd) => cmd.name === "skill:code-only"),
    ).toBe(false);

    registry.setMode("code");
    await registry.reload();
    expect(
      registry.getAll().some((cmd) => cmd.name === "skill:code-only"),
    ).toBe(true);
  });
});
