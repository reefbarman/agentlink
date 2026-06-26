import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  SlashCommandRegistry,
  loadAskAgentSlashCommands,
} from "./SlashCommandRegistry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("loads only safe projectless slash commands for Ask Agent", async () => {
    fs.mkdirSync(path.join(tmpHome, ".agentlink", "commands"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "commands", "global-safe.md"),
      "---\ndescription: Global safe prompt\n---\nUse this global prompt",
    );
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "commands", "remember.md"),
      "---\ndescription: Override remember\n---\nOverride durable memory prompt",
    );
    fs.mkdirSync(path.join(tmpHome, ".agentlink", "rules"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "rules", "global-rule.md"),
      "---\ndescription: Global rule\n---\nAlways be concise",
    );
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "rules", "empty-rule.md"),
      "---\ndescription: Empty rule\n---\n",
    );
    fs.mkdirSync(path.join(tmpDir, ".agentlink", "commands"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".agentlink", "commands", "project-unsafe.md"),
      "---\ndescription: Project command\n---\nUse this project prompt",
    );
    fs.mkdirSync(path.join(tmpDir, ".agentlink", "rules"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".agentlink", "rules", "project-rule.md"),
      "---\ndescription: Project rule\n---\nUse workspace state",
    );
    const globalSkillPath = writeSkill(
      path.join(tmpHome, ".agentlink", "skills"),
      "global-chat",
      "name: global-chat\ndescription: Global chat skill",
    );
    writeSkill(
      path.join(tmpHome, ".agentlink", "skills"),
      "unsafe-tool-skill",
      "name: unsafe-tool-skill\ndescription: Unsafe skill\nallowed-tools: execute_command",
    );
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "project-skill",
      "name: project-skill\ndescription: Project skill",
    );

    const commands = await loadAskAgentSlashCommands("ask");
    const names = commands.map((command) => command.name);

    expect(names).toContain("remember");
    expect(names).toContain("global-safe");
    expect(names).toContain("skill:global-chat");
    expect(names).toContain("rule:global-rule");
    expect(names).toContain("mcp");
    expect(names).toContain("mcp-config");
    expect(names).toContain("mcp-refresh");
    expect(commands.find((cmd) => cmd.name === "mcp")?.builtin).toBe(true);
    expect(commands.find((cmd) => cmd.name === "mcp-config")?.builtin).toBe(
      true,
    );
    expect(commands.find((cmd) => cmd.name === "mcp-refresh")?.builtin).toBe(
      true,
    );
    expect(names).not.toContain("new");
    expect(names).not.toContain("mode");
    expect(names).not.toContain("checkpoint");
    expect(names).not.toContain("revert");
    expect(names).not.toContain("btw");
    expect(names).not.toContain("pair");
    expect(names).not.toContain("project-unsafe");
    expect(names).not.toContain("skill:project-skill");
    expect(names).not.toContain("rule:project-rule");
    expect(names).not.toContain("rule:empty-rule");
    expect(names).not.toContain("skill:unsafe-tool-skill");
    const globalSkillCommand = commands.find(
      (cmd) => cmd.name === "skill:global-chat",
    );
    expect(globalSkillCommand).toMatchObject({
      source: "skill",
      builtin: false,
      skillPath: globalSkillPath,
    });
    expect(globalSkillCommand?.body).toContain(
      "Use the following AgentLink skill",
    );
    expect(globalSkillCommand?.body).toContain("# global-chat");
    expect(globalSkillCommand?.body).not.toContain("---");
    expect(globalSkillCommand?.body).not.toContain("load_skill");
    const rememberCommand = commands.find((cmd) => cmd.name === "remember");
    expect(rememberCommand?.body).toContain("propose_memory");
    expect(rememberCommand?.body).not.toContain(
      "Override durable memory prompt",
    );
    const globalRuleCommand = commands.find(
      (cmd) => cmd.name === "rule:global-rule",
    );
    expect(globalRuleCommand?.body).toContain(
      "Apply the following global rule",
    );
    expect(globalRuleCommand?.body).toContain("Always be concise");
    expect(commands.every((command) => command.source !== "project")).toBe(
      true,
    );
    expect(commands.every((command) => command.source !== "agentlink")).toBe(
      true,
    );
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
