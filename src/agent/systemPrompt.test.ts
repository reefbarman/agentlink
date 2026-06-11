import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPromptArtifacts,
  buildSystemPrompt,
  loadCustomInstructions,
  shouldInlineInstructionBlock,
} from "./systemPrompt.js";

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
    expect(result).toContain(
      "For any non-trivial implementation, spawn a background review agent automatically",
    );
    expect(result).toContain(
      "Default to spawning a review when the change feels large enough",
    );
    expect(result).toContain(
      "Spawn the review agent after completing the implementation",
    );
  });

  it("includes ask mode section for 'ask' mode", async () => {
    const result = await buildSystemPrompt("ask", tmpDir);
    expect(result).toContain("Ask mode");
    expect(result).toContain("Do not assume the user is correct");
  });

  it("includes architect mode section for 'architect' mode", async () => {
    const result = await buildSystemPrompt("architect", tmpDir);
    expect(result).toContain("Architect mode");
    expect(result).toContain("Write the plan to a Markdown file in `./plans`");
    expect(result).toContain("Review & Iteration");
    expect(result).toContain("switch_mode");
    expect(result).toContain(
      "For any non-trivial plan, spawn a background review agent automatically",
    );
    expect(result).toContain('threshold should be "large or consequential"');
    expect(result).toContain(
      "Spawn the review agent immediately after drafting the plan",
    );
  });

  it("includes review mode section for 'review' mode", async () => {
    const result = await buildSystemPrompt("review", tmpDir);
    expect(result).toContain("Review mode");
    expect(result).toContain("Executive summary");
    expect(result).toContain("Findings");
  });

  it("includes global technical judgment guidance", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("Technical Judgment");
    expect(result).toContain("Do not assume the user is correct");
    expect(result).toContain(
      "Do not manufacture disagreement. Push back only when it improves correctness, safety, or clarity.",
    );
    expect(result).toContain(
      "Ask clarifying questions when the technical assessment is uncertain; push back directly when it is clear.",
    );
  });

  it("requires ask_user for bounded choices and confirmations", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain(
      "If you need a bounded choice, confirmation, or yes/no decision, always use `ask_user`.",
    );
    expect(result).toContain(
      "Use inline plain-text questions only for genuinely open-ended free-form responses where structured UI would not help.",
    );
  });

  it("includes code mode technical judgment guidance", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain(
      "Validate the user's framing before committing to it",
    );
    expect(result).toContain(
      "Do not blindly accept requested solutions or follow-up feedback",
    );
  });

  it("includes debug mode diagnosis guidance", async () => {
    const result = await buildSystemPrompt("debug", tmpDir);
    expect(result).toContain("Do not assume the user's diagnosis is correct");
    expect(result).toContain(
      "Test hypotheses against evidence from code, logs, reproduction steps, and observed behavior.",
    );
    expect(result).toContain(
      "If the reported cause is wrong, say so clearly and explain the actual root cause.",
    );
  });

  it("includes review mode anti-speculation guidance", async () => {
    const result = await buildSystemPrompt("review", tmpDir);
    expect(result).toContain(
      "Do not assume the proposed change or task framing is correct.",
    );
    expect(result).toContain(
      "Prefer a small number of concrete, evidence-backed findings over speculative or cosmetic criticism.",
    );
    expect(result).toContain(
      "If no meaningful issues are found, say that clearly instead of forcing criticism.",
    );
  });

  it("shows plans folder does not exist when ./plans is absent", async () => {
    const result = await buildSystemPrompt("architect", tmpDir);
    expect(result).toContain("Plans folder (`./plans`): does not exist yet");
  });

  it("shows plans folder exists when ./plans is present", async () => {
    fs.mkdirSync(path.join(tmpDir, "plans"));
    const result = await buildSystemPrompt("architect", tmpDir);
    expect(result).toContain("Plans folder (`./plans`): exists");
  });

  it("does not include plans folder info for non-architect modes", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("Plans folder");
  });

  it("falls back to code mode for unknown modes", async () => {
    const result = await buildSystemPrompt("unknown-mode", tmpDir);
    expect(result).toContain("Code mode");
  });

  it("includes system info section", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("System Information");
  });

  it("lists workspace folders for multi-root workspaces", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      workspaceFolders: [
        { name: "api", path: "/work/api" },
        { name: "web", path: "/work/web" },
      ],
    });
    expect(result).toContain("Workspace Folders");
    expect(result).toContain("api: /work/api");
    expect(result).toContain("web: /work/web");
  });

  it("lists workspace folders in lightweight background review prompts", async () => {
    const result = await buildSystemPrompt("review", tmpDir, {
      isBackground: true,
      lightweight: true,
      workspaceFolders: [
        { name: "api", path: "/work/api" },
        { name: "web", path: "/work/web" },
      ],
    });
    expect(result).toContain("Workspace Folders");
    expect(result).toContain("api: /work/api");
    expect(result).toContain("web: /work/web");
  });

  it("omits the workspace folders section for a single root", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      workspaceFolders: [{ name: "api", path: "/work/api" }],
    });
    expect(result).not.toContain("Workspace Folders");
  });

  it("omits the workspace folders section when none provided", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("Workspace Folders");
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

  it("keeps rule files without frontmatter inline for backward compatibility", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "legacy.md"),
      "# Legacy standards\nLEGACY RULE BODY SHOULD STAY INLINE",
    );

    const result = await buildSystemPrompt("code", tmpDir);

    expect(result).toContain("## Custom Instructions");
    expect(result).toContain("# Instructions (.agentlink/rules/legacy.md):");
    expect(result).toContain("LEGACY RULE BODY SHOULD STAY INLINE");
    expect(result).not.toContain("## Rule Catalog");
  });

  it("defers rule-directory files with description frontmatter into a compact catalog", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "typescript.md"),
      "---\ndescription: TypeScript standards\n---\n# TypeScript standards\nHIDDEN TYPESCRIPT RULE BODY SHOULD BE DEFERRED",
    );

    const artifacts = await buildPromptArtifacts("code", tmpDir);

    expect(artifacts.systemPrompt).toContain("## Rule Catalog");
    expect(artifacts.systemPrompt).toContain(
      ".agentlink/rules/typescript.md — TypeScript standards",
    );
    expect(artifacts.systemPrompt).toContain(
      "Load when relevant with `load_rule` path: `.agentlink/rules/typescript.md`.",
    );
    expect(artifacts.advertisedRules).toContainEqual(
      expect.objectContaining({
        filePath: path.join(ruleDir, "typescript.md"),
        loadPath: ".agentlink/rules/typescript.md",
        summary: "TypeScript standards",
      }),
    );
    expect(artifacts.systemPrompt).not.toContain(
      "HIDDEN TYPESCRIPT RULE BODY SHOULD BE DEFERRED",
    );
    expect(artifacts.promptBreakdown.sections).toContainEqual(
      expect.objectContaining({
        label: "rule catalog (deferred)",
        count: 1,
      }),
    );
  });

  it("uses rule frontmatter description and globs in the deferred catalog", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "typescript.md"),
      "---\ndescription: TypeScript edit standards\nglobs: src/**/*.{ts,tsx}, tests/**/*.ts\n---\n# Fallback heading\nHIDDEN TYPESCRIPT RULE BODY SHOULD BE DEFERRED",
    );

    const artifacts = await buildPromptArtifacts("code", tmpDir);

    expect(artifacts.systemPrompt).toContain(
      ".agentlink/rules/typescript.md — TypeScript edit standards",
    );
    expect(artifacts.systemPrompt).toContain(
      "Applies to: src/**/*.{ts,tsx}, tests/**/*.ts.",
    );
    expect(artifacts.systemPrompt).toContain(
      "including when a listed glob matches files you will inspect or edit",
    );
    expect(artifacts.systemPrompt).not.toContain("Fallback heading");
    expect(artifacts.systemPrompt).not.toContain(
      "HIDDEN TYPESCRIPT RULE BODY SHOULD BE DEFERRED",
    );
  });

  it("inlines glob rule files when the active file matches at session creation", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "typescript.md"),
      "---\ndescription: TypeScript edit standards\nglobs: src/**/*.{ts,tsx}\n---\n# TypeScript standards\nMATCHED TYPESCRIPT RULE BODY",
    );

    const artifacts = await buildPromptArtifacts("code", tmpDir, {
      activeFilePath: path.join(tmpDir, "src", "components", "Button.tsx"),
    });

    expect(artifacts.systemPrompt).toContain("## Custom Instructions");
    expect(artifacts.systemPrompt).toContain(
      "# Instructions (.agentlink/rules/typescript.md):",
    );
    expect(artifacts.systemPrompt).toContain("MATCHED TYPESCRIPT RULE BODY");
    expect(artifacts.systemPrompt).not.toContain("## Rule Catalog");
    expect(
      artifacts.promptBreakdown.sections.some(
        (section) => section.label === "rule catalog (deferred)",
      ),
    ).toBe(false);
  });

  it("exposes the same active-file glob partitioning decision for debug metadata", () => {
    const block = {
      source: ".agentlink/rules/typescript.md",
      content: "# TypeScript standards",
      kind: "rule" as const,
      globs: ["src/**/*.{ts,tsx}"],
    };

    expect(
      shouldInlineInstructionBlock(block, tmpDir, {
        activeFilePath: path.join(tmpDir, "src", "index.ts"),
      }),
    ).toBe(true);
    expect(
      shouldInlineInstructionBlock(block, tmpDir, {
        activeFilePath: path.join(tmpDir, "docs", "index.md"),
      }),
    ).toBe(false);
  });

  it("keeps glob rule files deferred when the active file does not match", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "typescript.md"),
      "---\ndescription: TypeScript edit standards\nglobs: src/**/*.{ts,tsx}\n---\n# TypeScript standards\nUNMATCHED TYPESCRIPT RULE BODY",
    );

    const artifacts = await buildPromptArtifacts("code", tmpDir, {
      activeFilePath: path.join(tmpDir, "docs", "readme.md"),
    });

    expect(artifacts.systemPrompt).toContain("## Rule Catalog");
    expect(artifacts.systemPrompt).toContain(
      ".agentlink/rules/typescript.md — TypeScript edit standards",
    );
    expect(artifacts.systemPrompt).toContain("Applies to: src/**/*.{ts,tsx}.");
    expect(artifacts.systemPrompt).not.toContain(
      "UNMATCHED TYPESCRIPT RULE BODY",
    );
    expect(artifacts.promptBreakdown.sections).toContainEqual(
      expect.objectContaining({
        label: "rule catalog (deferred)",
        count: 1,
      }),
    );
  });

  it("supports YAML list-style globs and quoted frontmatter values", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "react.md"),
      "---\ndescription: \"React component standards\"\nglobs:\n  - 'src/**/*.tsx'\n  - tests/**/*.tsx\n---\n# Fallback heading\nHIDDEN REACT RULE BODY SHOULD BE DEFERRED",
    );

    const artifacts = await buildPromptArtifacts("code", tmpDir);

    expect(artifacts.systemPrompt).toContain(
      ".agentlink/rules/react.md — React component standards",
    );
    expect(artifacts.systemPrompt).toContain(
      "Applies to: src/**/*.tsx, tests/**/*.tsx.",
    );
    expect(artifacts.systemPrompt).not.toContain("Fallback heading");
    expect(artifacts.systemPrompt).not.toContain(
      "HIDDEN REACT RULE BODY SHOULD BE DEFERRED",
    );
  });

  it("keeps quoted alwaysApply rule files inline", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "security.md"),
      '---\nalwaysApply: "true"\n---\n# Security rules\nALWAYS INLINE SECURITY RULE',
    );

    const result = await buildSystemPrompt("code", tmpDir);

    expect(result).toContain("## Custom Instructions");
    expect(result).toContain("# Instructions (.agentlink/rules/security.md):");
    expect(result).toContain("ALWAYS INLINE SECURITY RULE");
    expect(result).not.toContain("alwaysApply");
    expect(result).not.toContain("## Rule Catalog");
  });

  it("keeps alwaysApply rule files inline", async () => {
    const ruleDir = path.join(tmpDir, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "security.md"),
      "---\nalwaysApply: true\n---\n# Security rules\nALWAYS INLINE SECURITY RULE",
    );

    const result = await buildSystemPrompt("code", tmpDir);

    expect(result).toContain("## Custom Instructions");
    expect(result).toContain("# Instructions (.agentlink/rules/security.md):");
    expect(result).toContain("ALWAYS INLINE SECURITY RULE");
    expect(result).not.toContain("alwaysApply: true");
    expect(result).not.toContain("## Rule Catalog");
  });

  it("keeps root instruction files inline while deferring rule files", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "ROOT INSTRUCTION CONTENT",
    );
    const ruleDir = path.join(tmpDir, ".claude", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "react.md"),
      "---\ndescription: React standards\n---\n# React standards\nHIDDEN REACT RULE BODY SHOULD BE DEFERRED",
    );

    const result = await buildSystemPrompt("code", tmpDir);

    expect(result).toContain("## Custom Instructions");
    expect(result).toContain("ROOT INSTRUCTION CONTENT");
    expect(result).toContain("## Rule Catalog");
    expect(result).toContain(".claude/rules/react.md");
    expect(result).toContain(".claude/rules/react.md — React standards");
    expect(result).not.toContain("HIDDEN REACT RULE BODY SHOULD BE DEFERRED");
  });

  it("catalogs global rule files with absolute load paths", async () => {
    const ruleDir = path.join(tmpHome, ".agentlink", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "global.md"),
      "---\ndescription: Global standards\n---\n# Global standards\nHIDDEN GLOBAL RULE BODY SHOULD BE DEFERRED",
    );

    const result = await buildSystemPrompt("code", tmpDir);

    expect(result).toContain("~/.agentlink/rules/global.md");
    expect(result).toContain(
      `Load when relevant with \`load_rule\` path: \`${path.join(ruleDir, "global.md")}\`.`,
    );
    expect(result).toContain("~/.agentlink/rules/global.md — Global standards");
    expect(result).not.toContain("HIDDEN GLOBAL RULE BODY SHOULD BE DEFERRED");
  });

  it("does not include a rule catalog section when no rule files exist", async () => {
    const artifacts = await buildPromptArtifacts("code", tmpDir);

    expect(artifacts.systemPrompt).not.toContain("## Rule Catalog");
    expect(
      artifacts.promptBreakdown.sections.some(
        (section) => section.label === "rule catalog (deferred)",
      ),
    ).toBe(false);
  });

  it("does not include custom instructions section when no files", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("Custom Instructions");
  });

  it("includes global and project memory as lower-authority durable context", async () => {
    fs.mkdirSync(path.join(tmpHome, ".agentlink"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "memory.md"),
      "global preference",
    );
    fs.mkdirSync(path.join(tmpDir, ".agentlink"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agentlink", "memory.md"),
      "project convention",
    );

    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("## Memory");
    expect(result).toContain(
      "lower authority than system/developer instructions",
    );
    expect(result).toContain(
      "# Memory (~/.agentlink/memory.md):\nglobal preference",
    );
    expect(result).toContain(
      "# Memory (.agentlink/memory.md):\nproject convention",
    );
    expect(result.indexOf("global preference")).toBeLessThan(
      result.indexOf("project convention"),
    );
  });

  it("omits memory section when no memory files exist", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("## Memory");
  });

  it("caps each memory file to recent content", async () => {
    fs.mkdirSync(path.join(tmpDir, ".agentlink"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agentlink", "memory.md"),
      `OMITTED_PREFIX${"old".repeat(5_000)}RECENT_MEMORY`,
    );

    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("RECENT_MEMORY");
    expect(result).toContain("Earlier content omitted:");
    expect(result).not.toContain("OMITTED_PREFIX");
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

  it("includes skill allowed-tools and invocation metadata", async () => {
    const skillDir = path.join(tmpDir, ".agentlink", "skills", "safe-review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: safe-review",
        "description: Safe review",
        "invocation: manual",
        "allowed-tools:",
        "  - read_file",
        "  - search_files",
        "---",
        "# Instructions",
      ].join("\n"),
    );

    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain('allowed-tools="read_file,search_files"');
    expect(result).toContain('invocation="manual"');
    expect(result).toContain('If a skill has `invocation="manual"`');
    expect(result).toContain("If a loaded skill declares `allowed-tools`");
  });

  it("includes bundled skills when no user or project skills exist", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("<skills>");
    expect(result).toContain("skill-writing");
    expect(result).toContain("resources/builtin-skills/skill-writing/SKILL.md");
    expect(result).toContain("rich-output");
    expect(result).toContain("resources/builtin-skills/rich-output/SKILL.md");
    expect(result).toContain("cross-session-memory");
    expect(result).toContain(
      "resources/builtin-skills/cross-session-memory/SKILL.md",
    );
  });

  it("slims situational base prompt guidance behind bundled skills", async () => {
    const result = await buildSystemPrompt("code", tmpDir);

    expect(result).toContain("Load the `rich-output` skill");
    expect(result).toContain("load the `cross-session-memory` skill");
    expect(result).toContain("durable preference");
    expect(result).toContain("Never bypass approval");
    expect(result).toContain("[memory-candidate]");
    expect(result).toContain(
      "Persistence always requires explicit user approval",
    );
    expect(result).not.toContain(
      "Prefer Mermaid for architecture, data flow, schemas, relationships, and workflows.",
    );
    expect(result).not.toContain(
      "Propose memory when user feedback generalizes across sessions",
    );
  });

  it("lets project skills override bundled skills by name", async () => {
    const skillDir = path.join(tmpDir, ".agentlink", "skills", "skill-writing");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: skill-writing\ndescription: Project override\n---\n# Project skill writing\n",
    );

    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("Project override");
    expect(result).toContain(
      path.join(tmpDir, ".agentlink", "skills", "skill-writing", "SKILL.md"),
    );
    expect(result).not.toContain(
      "resources/builtin-skills/skill-writing/SKILL.md",
    );
  });

  it("ignores mode-incompatible overrides when a bundled skill is visible", async () => {
    const skillDir = path.join(tmpDir, ".agentlink", "skills", "skill-writing");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: skill-writing\ndescription: Review-only override\nmodeSlugs: review\n---\n# Review skill writing\n",
    );

    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).toContain("skill-writing");
    expect(result).toContain("resources/builtin-skills/skill-writing/SKILL.md");
    expect(result).not.toContain("Review-only override");
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

  it("includes provider-specific section for codex provider", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      providerId: "codex",
    });
    expect(result).toContain("Provider-Specific Behavior");
    expect(result).toContain("Bias for action");
    expect(result).toContain("codebase_search");
    expect(result).toContain("Narrate your work");
  });

  it("includes provider section for anthropic provider", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      providerId: "anthropic",
    });
    expect(result).toContain("Provider-Specific Behavior");
    expect(result).toContain("Visible progress and rationale");
    expect(result).toContain("do not rely on hidden thinking");
  });

  it("gives anthropic models high-level code tool guidance", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      providerId: "anthropic",
      model: "claude-fable-5",
    });
    expect(result).toContain("Tool selection");
    expect(result).toContain("highest-level code intelligence tool");
    expect(result).toContain("Go directly to `get_context`");
    expect(result).toContain("prefer `get_context` over `read_file`");
    expect(result).toContain("`codebase_search` first for unknown locations");
    expect(result).toContain("`search_files` for exact matches only");
  });

  it("prefers get_context directly when a file path is already known", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      providerId: "codex",
    });
    expect(result).toContain("Known file path beats search");
    expect(result).toContain(
      "do not call `codebase_search` just to rediscover it",
    );
    expect(result).toContain("Go directly to `get_context`");
    expect(result).toContain("`get_context` for known files");
    expect(result).toContain("prefer `get_context` over `read_file`");
    expect(result).toContain("`codebase_search` FIRST for unknown locations");
    expect(result).toContain("`read_file` for exact reads");
  });

  it("does not include provider section when no providerId is given", async () => {
    const result = await buildSystemPrompt("code", tmpDir);
    expect(result).not.toContain("Provider-Specific Behavior");
  });

  it("includes deferred MCP tool catalog entries when provided", async () => {
    const artifacts = await buildPromptArtifacts("code", tmpDir, {
      mcpToolCatalog: [
        {
          serverName: "linear",
          toolCount: 46,
          estimatedTokens: 10_214,
          representativeTools: ["list_issues", "get_issue"],
        },
        {
          serverName: "notion",
          toolCount: 14,
          estimatedTokens: 13_679,
          representativeTools: ["notion-search"],
        },
      ],
    });

    expect(artifacts.systemPrompt).toContain("## MCP Tool Catalog");
    expect(artifacts.systemPrompt).toContain(
      "linear: 46 tools, ~10214 schema tokens deferred",
    );
    expect(artifacts.systemPrompt).toContain(
      "Representative tools: list_issues, get_issue",
    );
    expect(artifacts.systemPrompt).toContain(
      "notion: 14 tools, ~13679 schema tokens deferred",
    );
    expect(artifacts.promptBreakdown.sections).toContainEqual(
      expect.objectContaining({
        label: "mcp tool catalog",
        count: 2,
      }),
    );
  });

  it("includes MCP capability hints when catalog entries declare capabilities", async () => {
    const artifacts = await buildPromptArtifacts("code", tmpDir, {
      mcpToolCatalog: [
        {
          serverName: "ddg-search",
          toolCount: 2,
          estimatedTokens: 500,
          representativeTools: ["search", "fetch_content"],
          capabilities: ["web-search"],
        },
        {
          serverName: "chrome-devtools",
          toolCount: 29,
          estimatedTokens: 5_238,
          representativeTools: ["navigate", "click", "screenshot"],
          capabilities: ["browser-automation"],
        },
      ],
    });

    expect(artifacts.systemPrompt).toContain("### MCP capability hints");
    expect(artifacts.systemPrompt).toContain("web-search (ddg-search)");
    expect(artifacts.systemPrompt).toContain("prefer checking the web");
    expect(artifacts.systemPrompt).toContain(
      "browser-automation (chrome-devtools)",
    );
    expect(artifacts.systemPrompt).toContain("verifying in the browser");
  });

  it("omits the MCP tool catalog section when none is provided", async () => {
    const artifacts = await buildPromptArtifacts("code", tmpDir);

    expect(artifacts.systemPrompt).not.toContain("## MCP Tool Catalog");
    expect(
      artifacts.promptBreakdown.sections.some(
        (section) => section.label === "mcp tool catalog",
      ),
    ).toBe(false);
  });

  it("does not include provider section for unknown provider", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      providerId: "future-provider",
    });
    expect(result).not.toContain("Provider-Specific Behavior");
  });

  it("provider section appears between mode prompt and system info", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      providerId: "codex",
    });
    const modeIdx = result.indexOf("Code mode");
    const providerIdx = result.indexOf("Provider-Specific Behavior");
    const sysInfoIdx = result.indexOf("System Information");
    expect(modeIdx).toBeLessThan(providerIdx);
    expect(providerIdx).toBeLessThan(sysInfoIdx);
  });

  it("builds lightweight prompt for background review agents", async () => {
    // Even with custom instructions present, lightweight mode should skip them
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "project rules");
    const result = await buildSystemPrompt("review", tmpDir, {
      isBackground: true,
      lightweight: true,
    });
    // Should include the review mode content and background section
    expect(result).toContain("Review mode");
    expect(result).toContain("Background Agent");
    expect(result).toContain("background review agent");
    expect(result).toContain("3-5 tool calls");
    expect(result).toContain("Review stance:");
    expect(result).toContain(
      "Do not assume the foreground agent, the user, or the provided change is correct.",
    );
    expect(result).toContain(
      "If the change is sound, say so clearly instead of forcing criticism.",
    );
    // Should NOT include bloated sections
    expect(result).not.toContain("Communication Style");
    expect(result).not.toContain("Mermaid diagrams");
    expect(result).not.toContain("Rich Output");
    expect(result).not.toContain("Custom Instructions");
    expect(result).not.toContain("project rules");
    expect(result).not.toContain("Memory");
    expect(result).not.toContain("System Information");
    expect(result).not.toContain("Provider-Specific Behavior");
    expect(result).not.toContain("Do not manufacture disagreement");
  });

  it("lightweight prompt is significantly shorter than full prompt", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "project rules ".repeat(100),
    );
    const full = await buildSystemPrompt("review", tmpDir, {
      isBackground: true,
      providerId: "codex",
    });
    const lightweight = await buildSystemPrompt("review", tmpDir, {
      isBackground: true,
      lightweight: true,
      providerId: "codex",
    });
    // Lightweight should be at most half the size of full
    expect(lightweight.length).toBeLessThan(full.length * 0.5);
  });

  it("background review section has scope constraints", async () => {
    const result = await buildSystemPrompt("review", tmpDir, {
      isBackground: true,
    });
    expect(result).toContain("Scope rules");
    expect(result).toContain("3-5 tool calls");
    expect(result).toContain("Do not ask clarifying questions");
  });

  it("non-review background section does not have scope constraints", async () => {
    const result = await buildSystemPrompt("code", tmpDir, {
      isBackground: true,
    });
    expect(result).toContain("Background Agent");
    expect(result).not.toContain("Scope rules");
    expect(result).not.toContain("3-5 tool calls");
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
