import * as path from "path";

import { describe, expect, it } from "vitest";

import { isMemoryProtectedPath } from "./protectedPaths.js";

const cwd = path.resolve("/workspace/project");
const home = path.resolve("/Users/tester");

function p(...parts: string[]): string {
  return path.join(...parts);
}

describe("isMemoryProtectedPath", () => {
  it("protects workspace instruction files at any depth", () => {
    expect(isMemoryProtectedPath(p(cwd, "AGENTS.md"), { cwd, home })).toBe(
      true,
    );
    expect(
      isMemoryProtectedPath(p(cwd, "packages", "api", "CLAUDE.md"), {
        cwd,
        home,
      }),
    ).toBe(true);
    expect(
      isMemoryProtectedPath(p(cwd, "packages", "api", "AGENTS.local.md"), {
        cwd,
        home,
      }),
    ).toBe(true);
  });

  it("protects AgentLink memory, commands, skills, rules, and modes", () => {
    const protectedFiles = [
      p(cwd, ".agentlink", "memory.md"),
      p(cwd, ".agentlink", "commands", "release.md"),
      p(cwd, ".agentlink", "skills", "skill-writing", "SKILL.md"),
      p(cwd, ".agentlink", "rules", "style.md"),
      p(cwd, ".agentlink", "rules-code", "typescript.md"),
      p(cwd, ".agentlink", "modes.json"),
    ];

    for (const file of protectedFiles) {
      expect(isMemoryProtectedPath(file, { cwd, home }), file).toBe(true);
    }
  });

  it("protects global agent instruction locations", () => {
    const protectedFiles = [
      p(home, ".agentlink", "memory.md"),
      p(home, ".claude", "CLAUDE.md"),
      p(home, ".agents", "rules", "style.md"),
      p(home, ".agentlink", "skills", "x", "SKILL.md"),
    ];

    for (const file of protectedFiles) {
      expect(isMemoryProtectedPath(file, { cwd, home }), file).toBe(true);
    }
  });

  it("protects workspace dot-config memory paths even when cwd is omitted", () => {
    expect(isMemoryProtectedPath(p(cwd, ".agentlink", "memory.md"))).toBe(true);
    expect(
      isMemoryProtectedPath(
        p(cwd, ".agentlink", "skills", "skill-writing", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      isMemoryProtectedPath(p(cwd, ".claude", "rules-code", "typescript.md")),
    ).toBe(true);
  });

  it("does not protect ordinary source files", () => {
    expect(
      isMemoryProtectedPath(p(cwd, "src", "index.ts"), { cwd, home }),
    ).toBe(false);
    expect(
      isMemoryProtectedPath(p(cwd, ".agentlink", "cache", "tmp.json"), {
        cwd,
        home,
      }),
    ).toBe(false);
  });

  it("conservatively protects common instruction filenames outside cwd and home", () => {
    expect(
      isMemoryProtectedPath(p("/tmp", "other-project", "AGENTS.md"), {
        cwd,
        home,
      }),
    ).toBe(true);
  });
});
