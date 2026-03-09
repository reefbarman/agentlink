import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadCustomInstructions, buildSystemPrompt } from "./systemPrompt.js";

let tmpDir: string;
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-test-"));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-home-"));
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

describe("loadCustomInstructions", () => {
  it("returns empty string when no instruction files exist", async () => {
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toBe("");
  });

  it("loads AGENTS.md when present", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "agent rules");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("agent rules");
    expect(result).toContain("AGENTS.md");
  });

  it("loads CLAUDE.md when AGENTS.md is absent", async () => {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "claude rules");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("claude rules");
    expect(result).toContain("CLAUDE.md");
  });

  it("loads AGENT.md when AGENTS.md is absent", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENT.md"), "agent md rules");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("agent md rules");
    expect(result).toContain("AGENT.md");
  });

  it("AGENTS.md takes priority over AGENT.md and CLAUDE.md", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "agents content");
    fs.writeFileSync(path.join(tmpDir, "AGENT.md"), "agent content");
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "claude content");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("agents content");
    expect(result).not.toContain("agent content");
    expect(result).not.toContain("claude content");
  });

  it("AGENT.md takes priority over CLAUDE.md", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENT.md"), "agent content");
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "claude content");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("agent content");
    expect(result).not.toContain("claude content");
  });

  it("always loads AGENTS.local.md when present", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.local.md"), "local overrides");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("local overrides");
    expect(result).toContain("AGENTS.local.md");
  });

  it("loads both standard file and AGENTS.local.md", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "shared rules");
    fs.writeFileSync(path.join(tmpDir, "AGENTS.local.md"), "my overrides");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("shared rules");
    expect(result).toContain("my overrides");
  });

  it("trims whitespace from file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "  trimmed  \n");
    const result = await loadCustomInstructions(tmpDir);
    expect(result).toContain("trimmed");
    // The file content is trimmed before inclusion
    expect(result).not.toMatch(/^  trimmed  $/m);
  });
});

describe("buildSystemPrompt", () => {
  it("includes the cwd in the base prompt", async () => {
    const result = await buildSystemPrompt("code", "/my/project");
    expect(result).toContain("/my/project");
  });

  it("includes code mode section for 'code' mode", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("Code mode");
  });

  it("includes ask mode section for 'ask' mode", async () => {
    const result = await buildSystemPrompt("ask", tmpDir);
    expect(result).toContain("Ask mode");
  });

  it("includes architect mode section for 'architect' mode", async () => {
    const result = await buildSystemPrompt("architect", tmpDir);
    expect(result).toContain("Architect mode");
    expect(result).toContain("Write the plan to a Markdown file in `./plans`");
  });

  it("falls back to code mode for unknown modes", async () => {
    const result = await buildSystemPrompt("unknown-mode", tmpDir);
    expect(result).toContain("Code mode");
  });

  it("includes system info section", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("System Information");
  });

  it("does not include dev feedback section by default", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("Tool Feedback (Dev Mode)");
  });

  it("includes dev feedback section when devMode is true", async () => {
    const result = await buildSystemPrompt("code", tmpDir, { devMode: true });
    expect(result).toContain("Tool Feedback (Dev Mode)");
  });

  it("includes custom instructions when AGENTS.md exists", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "my custom rules");
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("my custom rules");
    expect(result).toContain("Custom Instructions");
  });

  it("does not include custom instructions section when no files", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("Custom Instructions");
  });

  it("includes skills section when a skill exists in .agentlink/skills/", async () => {
    const skillDir = path.join(tmpDir, ".agentlink", "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: Does something useful\n---\n# Instructions\nDo the thing.",
    );
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("Skills");
    expect(result).toContain("my-skill");
    expect(result).toContain("Does something useful");
    expect(result).toContain("SKILL.md");
  });

  it("omits skills section when no skills exist", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("<skills>");
  });

  it("excludes skills whose modeSlugs do not include the current mode", async () => {
    const skillDir = path.join(tmpDir, ".agentlink", "skills", "code-only");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: code-only\ndescription: Only for coders\nmodeSlugs: code\n---\n# Instructions",
    );
    const codeResult = await buildSystemPrompt("code", tmpDir);
    expect(codeResult).toContain("code-only");

    const askResult = await buildSystemPrompt("ask", tmpDir);
    expect(askResult).not.toContain("code-only");
  });

  it("skills in mode-specific directory override generic ones by same name", async () => {
    const genericDir = path.join(tmpDir, ".agentlink", "skills", "shared");
    const modeDir = path.join(tmpDir, ".agentlink", "skills-code", "shared");
    fs.mkdirSync(genericDir, { recursive: true });
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(
      path.join(genericDir, "SKILL.md"),
      "---\nname: shared\ndescription: Generic version\n---",
    );
    fs.writeFileSync(
      path.join(modeDir, "SKILL.md"),
      "---\nname: shared\ndescription: Code-specific version\n---",
    );
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("Code-specific version");
    expect(result).not.toContain("Generic version");
  });
});
