import { describe, expect, it } from "vitest";
import { parseReview, pickReviewModel, reviewPrompt } from "./taskReview.js";

import type { TaskRun } from "./taskStore.js";

const CODEX = { providerId: "codex", modelId: "gpt-5" };
const CLAUDE = { providerId: "meridian", modelId: "claude-opus" };
const HAIKU = { providerId: "meridian", modelId: "claude-haiku" };

describe("reviewer choice", () => {
  it("uses the review role on another provider, else any other provider", () => {
    expect(
      pickReviewModel(CODEX, { roleModel: HAIKU, available: [CODEX, CLAUDE] }),
    ).toEqual(HAIKU);
    expect(
      pickReviewModel(CLAUDE, { roleModel: HAIKU, available: [CODEX, CLAUDE] }),
    ).toEqual(CODEX);
    expect(pickReviewModel(CODEX, { available: [CODEX] })).toBeUndefined();
  });
});

describe("review findings", () => {
  it("reads the last JSON block", () => {
    const text = [
      'Example of the format: ```json\n{"verdict":"approve","findings":[]}\n```',
      "My review:",
      "```json",
      JSON.stringify({
        verdict: "changes_requested",
        findings: [
          { severity: "blocking", file: "a.ts", line: 4, reason: "Off by one" },
          { severity: "suggestion", reason: "Rename x", line: -2 },
        ],
      }),
      "```",
    ].join("\n");
    expect(parseReview(text)).toEqual({
      verdict: "changes_requested",
      findings: [
        { severity: "blocking", file: "a.ts", line: 4, reason: "Off by one" },
        { severity: "suggestion", reason: "Rename x" },
      ],
    });
  });

  it("treats any blocking finding as changes requested", () => {
    expect(
      parseReview(
        JSON.stringify({
          verdict: "approve",
          findings: [{ severity: "blocking", reason: "Breaks the build" }],
        }),
      )?.verdict,
    ).toBe("changes_requested");
  });

  it("refuses answers without readable findings", () => {
    expect(parseReview("Looks good!")).toBeUndefined();
    expect(parseReview(undefined)).toBeUndefined();
    expect(
      parseReview(
        '```json\n{"verdict":"approve","findings":[{"severity":"major","reason":"x"}]}\n```',
      ),
    ).toBeUndefined();
    expect(
      parseReview('```json\n{"verdict":"maybe","findings":[]}\n```'),
    ).toBeUndefined();
  });
});

describe("review prompt", () => {
  it("gives the objective, range and diff, and forbids changes", () => {
    const prompt = reviewPrompt(
      {
        objective: "Fix the clock",
        baseCommit: "base0",
        headCommit: "c1",
        branch: "agentlink/fix-1",
        workspace: "/projects/.tasks/aaaaaaaaaaaa/clock",
      } as TaskRun,
      { stat: "a.ts | 2", patch: "+b", truncated: true },
    );
    expect(prompt).toContain("The clone is the clock/ folder");
    expect(prompt).not.toContain("Reference repositories");
    expect(prompt).toContain("Fix the clock");
    expect(prompt).toContain("base0..c1");
    expect(prompt).toContain("+b");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("The diff was cut short");
    expect(prompt).not.toContain("validation commands");
  });

  it("tells the reviewer the owner's validation commands are in scope", () => {
    const prompt = reviewPrompt(
      {
        objective: "Add SECURITY.md",
        branch: "agentlink/sec-1",
        workspace: "/projects/.tasks/aaaaaaaaaaaa/site",
      } as TaskRun,
      { stat: "", patch: "", truncated: false },
      ["test -f CODE_OF_CONDUCT.md"],
    );
    expect(prompt).toContain("$ test -f CODE_OF_CONDUCT.md");
    expect(prompt).toContain("do not ask for them to be removed");
  });

  it("lists the task's read-only references", () => {
    const prompt = reviewPrompt(
      {
        objective: "Describe AgentLink",
        branch: "agentlink/describe-1",
        workspace: "/projects/.tasks/aaaaaaaaaaaa/site",
        references: ["https://github.com/reefbarman/agentlink"],
      } as unknown as TaskRun,
      { stat: "", patch: "", truncated: false },
    );
    expect(prompt).toContain(
      "  - https://github.com/reefbarman/agentlink at refs/reefbarman/agentlink/ (its default branch)",
    );
    expect(prompt).toContain("read but never change");
  });
});
