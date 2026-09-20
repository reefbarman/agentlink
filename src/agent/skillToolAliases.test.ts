import { describe, expect, it } from "vitest";

import { normalizeSkillToolNames } from "./skillToolAliases.js";

describe("normalizeSkillToolNames", () => {
  it("preserves unrestricted and deny-all policies distinctly", () => {
    expect(normalizeSkillToolNames(undefined)).toBeUndefined();
    expect(normalizeSkillToolNames([])).toEqual([]);
  });

  it("normalizes only exact Bash, deduplicates, and preserves declared names", () => {
    const declared = Object.freeze([
      "Bash",
      "execute_command",
      "Bash(git:*)",
      "bash",
      "Read",
      "read_file",
      " Bash",
      "Bash ",
    ]);
    expect(normalizeSkillToolNames(declared)).toEqual([
      "execute_command",
      "Bash(git:*)",
      "bash",
      "Read",
      "read_file",
      " Bash",
      "Bash ",
    ]);
    expect(declared[0]).toBe("Bash");
  });
});
