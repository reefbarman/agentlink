import * as path from "path";

import { describe, expect, it } from "vitest";

import { validateProtectedWriteCommand } from "./protectedWriteValidator.js";

const cwd = path.resolve("/workspace/project");

function expectProtected(command: string): void {
  const result = validateProtectedWriteCommand(command, cwd);
  expect(result, command).not.toBeNull();
  expect(result!.message).toContain("protected instructions or memory");
  expect(result!.message).toContain("force=true cannot bypass");
}

describe("validateProtectedWriteCommand", () => {
  it("rejects output redirection to protected files", () => {
    expectProtected("echo remember this >> AGENTS.md");
    expectProtected("printf hi > .agentlink/memory.md");
    expectProtected("cat <<'EOF' > .claude/CLAUDE.md\nhi\nEOF");
  });

  it("rejects tee to protected files", () => {
    expectProtected("echo hi | tee -a .agentlink/memory.md");
    expectProtected(
      "tee -- .agentlink/commands/release.md >/dev/null <<'EOF'\nhi\nEOF",
    );
  });

  it("rejects in-place edits to protected files", () => {
    expectProtected("sed -i 's/a/b/' AGENTS.md");
    expectProtected("perl -pi -e 's/a/b/' .agentlink/memory.md");
  });

  it("rejects copy and move destinations targeting protected files", () => {
    expectProtected("cp /tmp/new-memory .agentlink/memory.md");
    expectProtected("mv /tmp/skill .agentlink/skills/example/SKILL.md");
    expectProtected("install -m 644 /tmp/rules .agentlink/rules/style.md");
  });

  it("rejects copy and move directory destinations that would create protected files", () => {
    expectProtected("cp /tmp/memory.md .agentlink/");
    expectProtected("mv /tmp/AGENTS.md .");
    expectProtected("cp -t .agentlink /tmp/memory.md");
    expectProtected("install -m 644 /tmp/CLAUDE.md .claude/");
  });

  it("rejects dd and git restore targets targeting protected files", () => {
    expectProtected("dd if=/tmp/data of=.agentlink/memory.md");
    expectProtected("git restore -- AGENTS.md");
    expectProtected("git checkout -- .agentlink/memory.md");
  });

  it("allows ordinary command writes", () => {
    expect(
      validateProtectedWriteCommand("echo hi > tmp/out.txt", cwd),
    ).toBeNull();
    expect(validateProtectedWriteCommand("cp a src/file.ts", cwd)).toBeNull();
    expect(
      validateProtectedWriteCommand("sed -i 's/a/b/' src/file.ts", cwd),
    ).toBeNull();
  });

  it("does not guess dynamic targets", () => {
    expect(validateProtectedWriteCommand("echo hi > $TARGET", cwd)).toBeNull();
    expect(
      validateProtectedWriteCommand("cp a $(pwd)/AGENTS.md", cwd),
    ).toBeNull();
  });
});
