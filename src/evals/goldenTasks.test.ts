import { describe, expect, it } from "vitest";
import { getAgentTools } from "../agent/toolAdapter.js";
import {
  GOLDEN_TASKS,
  gradeGoldenTask,
  type GoldenTask,
} from "./goldenTasks.js";

const task = (expect: GoldenTask["expect"]): GoldenTask => ({
  id: "t",
  mode: "code",
  prompt: "p",
  intent: "i",
  expect,
});

describe("gradeGoldenTask", () => {
  it("passes when any first-response call matches and none are forbidden", () => {
    const grade = gradeGoldenTask(
      task({ anyOf: ["read_file"], forbid: ["spawn_background_agent"] }),
      [
        { name: "todo_write", input: {} },
        { name: "read_file", input: { path: "a.ts" } },
      ],
    );
    expect(grade).toEqual({
      pass: true,
      tools: ["todo_write", "read_file"],
      reasons: [],
    });
  });

  it("fails on a forbidden tool even when an expected tool is present", () => {
    const grade = gradeGoldenTask(
      task({ anyOf: ["read_file"], forbid: ["spawn_background_agent"] }),
      [
        { name: "read_file", input: {} },
        { name: "spawn_background_agent", input: {} },
      ],
    );
    expect(grade.pass).toBe(false);
    expect(grade.reasons).toEqual(["called forbidden spawn_background_agent"]);
  });

  it("unwraps call_native_tool to its target tool and input", () => {
    const grade = gradeGoldenTask(
      task({
        anyOf: ["list_mcp_resources"],
        inputMatches: { tool: "list_mcp_resources", pattern: /server/ },
      }),
      [
        {
          name: "call_native_tool",
          input: { name: "list_mcp_resources", input: { server: "x" } },
        },
      ],
    );
    expect(grade).toMatchObject({ pass: true, tools: ["list_mcp_resources"] });
  });

  it("reports a non-matching skill path", () => {
    const grade = gradeGoldenTask(
      task({
        anyOf: ["load_skill"],
        inputMatches: { tool: "load_skill", pattern: /documentation/ },
      }),
      [{ name: "load_skill", input: { path: "/x/skill-writing/SKILL.md" } }],
    );
    expect(grade.pass).toBe(false);
    expect(grade.reasons[0]).toContain("does not match");
  });

  it("allows read-only shell checks but fails shell file writes", () => {
    const rename = GOLDEN_TASKS.find((t) => t.id === "rename-without-shell")!;
    const shell = (command: string) => [
      { name: "execute_command", input: { command } },
    ];
    expect(gradeGoldenTask(rename, shell("git grep -n randomId")).pass).toBe(
      true,
    );
    expect(gradeGoldenTask(rename, shell("npm test 2>&1")).pass).toBe(true);
    expect(
      gradeGoldenTask(rename, shell("sed -i '' s/randomId/x/g a.ts")).pass,
    ).toBe(false);
    expect(gradeGoldenTask(rename, shell("echo x > a.ts")).pass).toBe(false);
  });

  it("treats a text-only reply as a pass only when allowed", () => {
    expect(gradeGoldenTask(task({ anyOf: ["ask_user"] }), []).pass).toBe(false);
    expect(
      gradeGoldenTask(task({ anyOf: ["ask_user"], allowNoToolCall: true }), [])
        .pass,
    ).toBe(true);
  });
});

describe("GOLDEN_TASKS", () => {
  it("has unique ids and only references real AgentLink tools", () => {
    const ids = GOLDEN_TASKS.map((golden) => golden.id);
    expect(new Set(ids).size).toBe(ids.length);

    const known = new Set(
      getAgentTools(
        undefined,
        [],
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        ["search", "fetch"],
      ).map((tool) => tool.name),
    );
    known.add("todo_write");
    for (const golden of GOLDEN_TASKS) {
      const referenced = [
        ...(golden.expect.anyOf ?? []),
        ...(golden.expect.forbid ?? []),
        ...(golden.expect.inputMatches
          ? [golden.expect.inputMatches.tool]
          : []),
        ...(golden.expect.forbidInputMatches
          ? [golden.expect.forbidInputMatches.tool]
          : []),
      ];
      for (const name of referenced) {
        expect(known, `${golden.id} references ${name}`).toContain(name);
      }
    }
  });
});
