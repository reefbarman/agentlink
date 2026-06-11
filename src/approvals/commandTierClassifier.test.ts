import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  classifyCommand,
  isTierAtOrBelow,
  type CommandTierContext,
} from "./commandTierClassifier.js";

const root = path.resolve("/workspace/project");
const ctx: CommandTierContext = {
  cwd: root,
  workspaceRoots: [root],
};

function tier(command: string, override: Partial<CommandTierContext> = {}) {
  return classifyCommand(command, { ...ctx, ...override }).tier;
}

describe("command tier classifier", () => {
  it("classifies read-only commands as safe", () => {
    expect(tier("git status --short")).toBe("safe");
    expect(tier("rg needle src")).toBe("safe");
    expect(tier("node --version")).toBe("safe");
    expect(tier("python --version")).toBe("safe");
  });

  it("classifies workspace-local mutations and unknown plain commands as sensitive", () => {
    expect(tier("mkdir src/generated")).toBe("sensitive");
    expect(tier("npm test")).toBe("sensitive");
    expect(tier("custom-tool --flag")).toBe("sensitive");
  });

  it("classifies destructive and external commands as dangerous", () => {
    expect(tier("rm -rf dist")).toBe("dangerous");
    expect(tier("sudo git status")).toBe("dangerous");
    expect(tier("git push origin main")).toBe("dangerous");
    expect(tier("curl https://example.com")).toBe("dangerous");
  });

  it("uses the highest tier across compound commands", () => {
    expect(tier("git status && mkdir tmp")).toBe("sensitive");
    expect(tier("git status && rm -rf tmp")).toBe("dangerous");
  });

  it("escalates opaque shell syntax and inline interpreters", () => {
    expect(tier("echo $(whoami)")).toBe("dangerous");
    expect(tier("PATH=/tmp:$PATH git status")).toBe("dangerous");
    expect(tier("$CMD arg")).toBe("dangerous");
    expect(tier("python -c 'print(1)'")).toBe("dangerous");
    expect(tier("node -e 'console.log(1)'")).toBe("dangerous");
    expect(tier("bash -c 'git status'")).toBe("dangerous");
  });

  it("escalates read and write paths outside the workspace", () => {
    expect(tier("rg token /tmp/outside")).toBe("dangerous");
    expect(tier("rg token ~/.ssh")).toBe("dangerous");
    expect(tier("mkdir generated", { cwd: "/tmp" })).toBe("dangerous");
    expect(tier("echo ok > /tmp/outside.txt")).toBe("dangerous");
    expect(tier("echo ok > generated.txt")).toBe("sensitive");
  });

  it("escalates shell-expanded paths before runtime expansion", () => {
    expect(tier("cat $HOME/.ssh/id_rsa")).toBe("dangerous");
    expect(tier("cat ${HOME}/.ssh/id_rsa")).toBe("dangerous");
    expect(tier("echo ok > $HOME/.bashrc")).toBe("dangerous");
  });

  it("detects attached redirections", () => {
    expect(tier("echo ok>/tmp/outside.txt")).toBe("dangerous");
    expect(tier("echo ok>>generated.txt")).toBe("sensitive");
  });

  it("honors threshold ordering", () => {
    expect(isTierAtOrBelow("safe", "safe")).toBe(true);
    expect(isTierAtOrBelow("sensitive", "safe")).toBe(false);
    expect(isTierAtOrBelow("sensitive", "sensitive")).toBe(true);
    expect(isTierAtOrBelow("dangerous", "sensitive")).toBe(false);
    expect(isTierAtOrBelow("safe", "off")).toBe(false);
  });
});
