import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type { HostToolExecutionContext } from "@agentlink/core";
import { createNodeHostAgentInstructions } from "./agentInstructions.js";
import path from "node:path";
import { tmpdir } from "node:os";

let root: string;
let home: string;
let project: string;
let builtin: string;

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function skill(name: string, body = `${name} body`): string {
  return `---\nname: ${name}\ndescription: Use ${name} for tests.\n---\n${body}\n`;
}

const context = {
  sessionId: "s1",
  turnId: "t1",
} as unknown as HostToolExecutionContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-instructions-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  builtin = path.join(root, "builtin");
  await mkdir(path.join(project, ".git"), { recursive: true });
  await put(path.join(home, ".agentlink", "CLAUDE.md"), "GLOBAL-OWNER-RULES");
  await put(
    path.join(home, ".agentlink", "skills", "global-skill", "SKILL.md"),
    skill("global-skill"),
  );
  await put(
    path.join(home, ".agentlink", "rules", "deferred-global.md"),
    "---\ndescription: Global deferred rule\nalwaysApply: false\n---\nGLOBAL-RULE-BODY",
  );
  await put(path.join(project, "AGENTS.md"), "PROJECT-RULES");
  await put(path.join(project, "AGENTS.local.md"), "LOCAL-OVERRIDES");
  await put(
    path.join(project, ".agentlink", "rules", "deferred.md"),
    "---\ndescription: Deferred project rule\nalwaysApply: false\n---\nPROJECT-RULE-BODY",
  );
  await put(
    path.join(project, ".agentlink", "skills", "project-skill", "SKILL.md"),
    skill("project-skill", "PROJECT-SKILL-BODY"),
  );
  await put(path.join(builtin, "docs", "SKILL.md"), skill("docs"));
  await put(path.join(builtin, "docs", "references", "a.md"), "REFERENCE-A");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createNodeHostAgentInstructions", () => {
  it("renders VS Code's instruction, rule and skill sections for a project", async () => {
    const instructions = createNodeHostAgentInstructions({
      projectRoot: project,
      homeDir: home,
      builtinSkillDirs: [builtin],
    });
    const prompt = await instructions.resolveInstructions({
      session: { sessionId: "s1" },
      turnId: "t1",
    });

    expect(prompt).toContain("## Custom Instructions");
    expect(prompt).toContain(
      "# Instructions (~/.agentlink/CLAUDE.md):\nGLOBAL-OWNER-RULES",
    );
    expect(prompt).toContain("# Instructions (AGENTS.md):\nPROJECT-RULES");
    expect(prompt).toContain(
      "# Instructions (AGENTS.local.md):\nLOCAL-OVERRIDES",
    );
    // Global before project before local, as in VS Code.
    expect(prompt.indexOf("GLOBAL-OWNER-RULES")).toBeLessThan(
      prompt.indexOf("PROJECT-RULES"),
    );
    expect(prompt.indexOf("PROJECT-RULES")).toBeLessThan(
      prompt.indexOf("LOCAL-OVERRIDES"),
    );
    expect(prompt).toContain("## Rule Catalog");
    expect(prompt).toContain(
      "Load when relevant with `load_rule` path: `.agentlink/rules/deferred.md`",
    );
    expect(prompt).not.toContain("PROJECT-RULE-BODY");
    expect(prompt).toContain("## Skills");
    for (const name of ["global-skill", "project-skill", "docs"]) {
      expect(prompt).toContain(`name="${name}"`);
    }
    expect(prompt).toContain("this host does not enforce the restriction");
  });

  it("adds no prompt text or tools when there is nothing to advertise", async () => {
    const empty = path.join(root, "empty");
    await mkdir(path.join(empty, ".git"), { recursive: true });
    const instructions = createNodeHostAgentInstructions({
      projectRoot: empty,
      homeDir: null,
    });
    const snapshot = await instructions.snapshot();
    expect(snapshot.prompt).toBe("");
    expect(instructions.toolDefinitions(snapshot)).toEqual([]);
  });

  it("keeps VS Code's enforced-restriction wording when the host enforces it", async () => {
    const snapshot = await createNodeHostAgentInstructions({
      projectRoot: project,
      homeDir: home,
      enforcesSkillToolRestrictions: true,
    }).snapshot();
    expect(snapshot.prompt).toContain(
      "those tools become the active tool restriction for subsequent turns",
    );
  });

  it("skips global sources when homeDir is null", async () => {
    const snapshot = await createNodeHostAgentInstructions({
      projectRoot: project,
      homeDir: null,
    }).snapshot();
    expect(snapshot.prompt).toContain("PROJECT-RULES");
    expect(snapshot.prompt).not.toContain("GLOBAL-OWNER-RULES");
    expect(snapshot.skills.map((entry) => entry.name)).toEqual([
      "project-skill",
    ]);
  });

  it("serves global sources only without a project, with absolute rule paths", async () => {
    const instructions = createNodeHostAgentInstructions({ homeDir: home });
    const snapshot = await instructions.snapshot();
    const rulePath = path.join(
      home,
      ".agentlink",
      "rules",
      "deferred-global.md",
    );
    expect(snapshot.prompt).toContain("GLOBAL-OWNER-RULES");
    expect(snapshot.prompt).not.toContain("PROJECT-RULES");
    expect(snapshot.advertisedRules.map((rule) => rule.loadPath)).toEqual([
      rulePath,
    ]);
    const loaded = await instructions.executeTool(
      "load_rule",
      { path: rulePath },
      snapshot,
    );
    expect(loaded.result.isError).toBeFalsy();
    expect(loaded.result.data).toMatchObject({ content: "GLOBAL-RULE-BODY" });
  });

  it("offers load_skill, read_skill_resource and load_rule as host tools", async () => {
    const instructions = createNodeHostAgentInstructions({
      projectRoot: project,
      homeDir: home,
      builtinSkillDirs: [builtin],
    });
    const tools = await instructions.resolveTools({
      principal: { id: "p" },
      sessionId: "s1",
      turnId: "t1",
    } as never);
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    expect([...byName.keys()]).toEqual([
      "load_skill",
      "read_skill_resource",
      "load_rule",
    ]);

    const skillPath = path.join(
      project,
      ".agentlink",
      "skills",
      "project-skill",
      "SKILL.md",
    );
    const activated = await byName
      .get("load_skill")!
      .execute({ path: skillPath }, context);
    expect(activated.isError).toBeFalsy();
    expect(activated.displayContent).toMatchObject({
      kind: "skill_activation",
      skill_name: "project-skill",
      skill_id: "project:agentlink:.agentlink/skills/project-skill",
    });
    expect(String(activated.modelContent)).toContain("PROJECT-SKILL-BODY");

    const resource = await byName.get("read_skill_resource")!.execute(
      {
        skill_path: path.join(builtin, "docs", "SKILL.md"),
        resource_path: "references/a.md",
      },
      context,
    );
    expect(resource.displayContent).toMatchObject({ content: "REFERENCE-A" });

    const rule = await byName
      .get("load_rule")!
      .execute({ path: ".agentlink/rules/deferred.md" }, context);
    expect(rule.displayContent).toMatchObject({
      content: "PROJECT-RULE-BODY",
    });

    const outside = await byName
      .get("load_skill")!
      .execute({ path: path.join(project, "AGENTS.md") }, context);
    expect(outside.isError).toBe(true);
  });

  it("omits load_rule when no rule is deferred", async () => {
    await rm(path.join(project, ".agentlink", "rules"), { recursive: true });
    const instructions = createNodeHostAgentInstructions({
      projectRoot: project,
      homeDir: null,
    });
    const snapshot = await instructions.snapshot();
    expect(instructions.toolDefinitions(snapshot).map((t) => t.name)).toEqual([
      "load_skill",
      "read_skill_resource",
    ]);
  });

  it("uses one catalog for a turn's prompt and tools", async () => {
    const instructions = createNodeHostAgentInstructions({
      projectRoot: project,
      homeDir: null,
    });
    const turn = { sessionId: "s1", turnId: "t1" };
    const first = await instructions.snapshot(turn);
    await put(path.join(project, "AGENTS.md"), "CHANGED");
    expect(await instructions.snapshot(turn)).toBe(first);
    expect(
      (await instructions.snapshot({ sessionId: "s1", turnId: "t2" })).prompt,
    ).toContain("CHANGED");
  });
});
