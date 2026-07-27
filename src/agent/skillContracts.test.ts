import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeSkillCapabilityPolicy,
  getSkillDiscoveryRoots,
  loadSkillCatalog,
  parseFrontmatter,
} from "./skillLoader.js";

let tmpDir: string;
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function writeSkill(
  sourceRoot: string,
  directoryName: string,
  frontmatter: string,
  body = "# Instructions\n\nFollow the workflow.",
): string {
  const skillDir = path.join(sourceRoot, directoryName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n${body}`);
  return skillPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-skill-contract-"));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-skill-home-"));
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

describe("canonical skill frontmatter", () => {
  it("parses standards-compatible quoted, folded, literal, and list values", () => {
    const parsed = parseFrontmatter(`---
name: yaml-skill
description: >-
  Review YAML: preserve # markers and
  fold this description.
notes: |
  first
  second
allowed-tools:
  - read_file
  - "server:lookup"
---
# Body`);

    expect(parsed).toMatchObject({
      name: "yaml-skill",
      description: "Review YAML: preserve # markers and fold this description.",
      notes: "first\nsecond\n",
      "allowed-tools": ["read_file", "server:lookup"],
    });
  });

  it("rejects duplicate YAML keys instead of silently choosing one", () => {
    expect(() =>
      parseFrontmatter(`---
name: first
name: second
description: duplicate
---`),
    ).toThrow(/map keys must be unique|name/i);
  });
});

describe("canonical skill catalog", () => {
  it("exposes stable identity, revision, provenance, and policy metadata", async () => {
    const skillPath = writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "review-helper",
      [
        "name: review-helper",
        "description: Review helper",
        "invocation: manual",
        "dependencies: [base-helper]",
        "recommendations: [rich-output]",
        "restrictions:",
        "  allowed-tools: [read_file, search_files]",
        "permissions:",
        "  tools: [execute_command]",
      ].join("\n"),
    );
    writeSkill(
      path.join(tmpDir, ".agents", "skills"),
      "base-helper",
      "name: base-helper\ndescription: Base helper",
    );

    const first = await loadSkillCatalog(tmpDir, "code");
    const second = await loadSkillCatalog(tmpDir, "code");
    const skill = first.entries.find((entry) => entry.name === "review-helper");

    expect(first.revision).toBe(second.revision);
    expect(skill).toMatchObject({
      id: "project:agentlink:.agentlink/skills/review-helper",
      name: "review-helper",
      skillPath,
      invocation: "manual",
      dependencies: ["base-helper"],
      recommendations: ["rich-output"],
      restrictions: { allowedTools: ["read_file", "search_files"] },
      permissions: { requestedTools: ["execute_command"] },
      provenance: {
        scope: "project",
        namespace: "agentlink",
      },
    });
    expect(skill?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(skill?.resolvedDependencies).toHaveLength(1);
    expect(skill?.resolvedDependencies[0]).toContain("base-helper");

    fs.appendFileSync(skillPath, "\nAdditional reviewed guidance.\n");
    const changed = await loadSkillCatalog(tmpDir, "code");
    expect(changed.revision).not.toBe(first.revision);
    expect(
      changed.entries.find((entry) => entry.name === "review-helper")?.revision,
    ).not.toBe(skill?.revision);
  });

  it("keeps project skill identities stable from nested working directories", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "stable-helper",
      "name: stable-helper\ndescription: Stable helper",
    );
    const nested = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    const fromRoot = await loadSkillCatalog(tmpDir, "code");
    const fromNested = await loadSkillCatalog(nested, "code");
    const rootSkill = fromRoot.entries.find(
      (entry) => entry.name === "stable-helper",
    );
    const nestedSkill = fromNested.entries.find(
      (entry) => entry.name === "stable-helper",
    );

    expect(getSkillDiscoveryRoots(nested)).toEqual([
      tmpDir,
      path.join(tmpDir, "packages"),
      nested,
    ]);
    expect(rootSkill?.id).toBe(
      "project:agentlink:.agentlink/skills/stable-helper",
    );
    expect(nestedSkill?.id).toBe(rootSkill?.id);
    expect(nestedSkill?.provenance.scope).toBe("ancestor");
  });

  it("does not discover skills above the nearest repository boundary", async () => {
    const repository = path.join(tmpDir, "repo");
    const nested = path.join(repository, "packages", "app");
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "outside-helper",
      "name: outside-helper\ndescription: Outside helper",
    );
    writeSkill(
      path.join(repository, ".agentlink", "skills"),
      "inside-helper",
      "name: inside-helper\ndescription: Inside helper",
    );

    const catalog = await loadSkillCatalog(nested, "code");

    expect(
      catalog.entries.some((entry) => entry.name === "inside-helper"),
    ).toBe(true);
    expect(
      catalog.entries.some((entry) => entry.name === "outside-helper"),
    ).toBe(false);
  });

  it("disables exact canonical IDs before resolving dependencies", async () => {
    writeSkill(
      path.join(tmpDir, ".agents", "skills"),
      "shared-helper",
      "name: shared-helper\ndescription: Agents helper",
    );
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "shared-helper",
      "name: shared-helper\ndescription: AgentLink helper",
    );
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "dependent-helper",
      [
        "name: dependent-helper",
        "description: Depends on the AgentLink helper",
        "dependencies: [project:agentlink:.agentlink/skills/shared-helper]",
      ].join("\n"),
    );
    const disabledId = "project:agentlink:.agentlink/skills/shared-helper";

    const catalog = await loadSkillCatalog(tmpDir, "code", {
      disabledSkillIds: [disabledId],
    });
    const disabled = catalog.entries.find((entry) => entry.id === disabledId);
    const sameNameEnabled = catalog.entries.find(
      (entry) => entry.name === "shared-helper" && entry.id !== disabledId,
    );
    const dependent = catalog.entries.find(
      (entry) => entry.name === "dependent-helper",
    );

    expect(disabled).toMatchObject({
      enabled: false,
      disabledReason: "configuration",
    });
    expect(sameNameEnabled?.enabled).toBe(true);
    expect(dependent).toMatchObject({
      enabled: false,
      disabledReason: "missing-dependency",
    });
    expect(
      catalog.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "missing-dependency" &&
          diagnostic.skillId === dependent?.id,
      ),
    ).toBe(true);
  });

  it("preserves duplicate short names and emits source-aware collision diagnostics", async () => {
    writeSkill(
      path.join(tmpDir, ".agents", "skills"),
      "shared-helper",
      "name: shared-helper\ndescription: Cross-agent helper",
    );
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "shared-helper",
      "name: shared-helper\ndescription: AgentLink helper",
    );

    const catalog = await loadSkillCatalog(tmpDir, "code");
    const matching = catalog.entries.filter(
      (entry) => entry.name === "shared-helper",
    );

    expect(matching).toHaveLength(2);
    expect(new Set(matching.map((entry) => entry.id)).size).toBe(2);
    expect(catalog.collisions).toContainEqual({
      name: "shared-helper",
      skillIds: matching.map((entry) => entry.id).sort(),
    });
    expect(
      catalog.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "name-collision" &&
          diagnostic.message.includes("shared-helper"),
      ),
    ).toHaveLength(2);
  });

  it("treats empty allowed-tools declarations as neutral", async () => {
    const sourceRoot = path.join(tmpDir, ".agentlink", "skills");
    writeSkill(
      sourceRoot,
      "empty-top-level",
      "name: empty-top-level\ndescription: Empty top-level restriction\nallowed-tools: []",
    );
    writeSkill(
      sourceRoot,
      "empty-nested",
      [
        "name: empty-nested",
        "description: Empty nested restriction",
        "restrictions:",
        "  allowed-tools:",
      ].join("\n"),
    );

    const catalog = await loadSkillCatalog(tmpDir, "code");

    for (const name of ["empty-top-level", "empty-nested"]) {
      expect(
        catalog.entries.find((entry) => entry.name === name),
      ).toMatchObject({
        allowedTools: undefined,
        restrictions: { allowedTools: undefined },
      });
    }
  });

  it("reports malformed metadata and missing dependencies without advertising them", async () => {
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "broken-yaml",
      "name: [unterminated\ndescription: broken",
    );
    writeSkill(
      path.join(tmpDir, ".agentlink", "skills"),
      "dependent-helper",
      "name: dependent-helper\ndescription: Depends on missing\ndependencies: [missing-helper]",
    );

    const catalog = await loadSkillCatalog(tmpDir, "code");

    expect(
      catalog.diagnostics.some(
        (diagnostic) => diagnostic.code === "invalid-frontmatter",
      ),
    ).toBe(true);
    expect(
      catalog.entries.find((entry) => entry.name === "dependent-helper"),
    ).toMatchObject({
      enabled: false,
      disabledReason: "missing-dependency",
    });
    expect(
      catalog.diagnostics.some(
        (diagnostic) => diagnostic.code === "missing-dependency",
      ),
    ).toBe(true);
  });

  it("propagates dependency failures through chains and cycle dependents", async () => {
    const sourceRoot = path.join(tmpDir, ".agentlink", "skills");
    writeSkill(
      sourceRoot,
      "missing-leaf",
      "name: missing-leaf\ndescription: Missing leaf\ndependencies: [absent]",
    );
    writeSkill(
      sourceRoot,
      "middle",
      "name: middle\ndescription: Middle\ndependencies: [missing-leaf]",
    );
    writeSkill(
      sourceRoot,
      "root",
      "name: root\ndescription: Root\ndependencies: [middle]",
    );
    writeSkill(
      sourceRoot,
      "cycle-a",
      "name: cycle-a\ndescription: Cycle A\ndependencies: [cycle-b]",
    );
    writeSkill(
      sourceRoot,
      "cycle-b",
      "name: cycle-b\ndescription: Cycle B\ndependencies: [cycle-a]",
    );
    writeSkill(
      sourceRoot,
      "cycle-dependent",
      "name: cycle-dependent\ndescription: Cycle dependent\ndependencies: [cycle-a]",
    );

    const catalog = await loadSkillCatalog(tmpDir, "code");

    for (const name of ["missing-leaf", "middle", "root"]) {
      expect(
        catalog.entries.find((entry) => entry.name === name),
      ).toMatchObject({
        enabled: false,
        disabledReason: "missing-dependency",
      });
    }
    for (const name of ["cycle-a", "cycle-b"]) {
      expect(
        catalog.entries.find((entry) => entry.name === name),
      ).toMatchObject({
        enabled: false,
        disabledReason: "dependency-cycle",
      });
    }
    expect(
      catalog.entries.find((entry) => entry.name === "cycle-dependent"),
    ).toMatchObject({
      enabled: false,
      disabledReason: "missing-dependency",
    });
  });

  it("rejects skill directory symlinks that escape the declared source root", async () => {
    const sourceRoot = path.join(tmpDir, ".agentlink", "skills");
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-outside-skill-"),
    );
    try {
      writeSkill(
        outsideRoot,
        "escaped-helper",
        "name: escaped-helper\ndescription: Escaped helper",
      );
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.symlinkSync(
        path.join(outsideRoot, "escaped-helper"),
        path.join(sourceRoot, "escaped-helper"),
        "dir",
      );

      const catalog = await loadSkillCatalog(tmpDir, "code");
      expect(
        catalog.entries.some((entry) => entry.name === "escaped-helper"),
      ).toBe(false);
      expect(
        catalog.diagnostics.some(
          (diagnostic) => diagnostic.code === "unsafe-symlink",
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe("skill capability policy composition", () => {
  it("intersects restrictions monotonically and unions non-authorizing metadata", async () => {
    const sourceRoot = path.join(tmpDir, ".agentlink", "skills");
    writeSkill(
      sourceRoot,
      "narrow-skill",
      [
        "name: narrow-skill",
        "description: Narrow skill",
        "dependencies: [neutral-skill]",
        "recommendations: [rich-output]",
        "restrictions:",
        "  allowed-tools: [read_file]",
        "permissions:",
        "  tools: [execute_command]",
      ].join("\n"),
    );
    writeSkill(
      sourceRoot,
      "broad-skill",
      [
        "name: broad-skill",
        "description: Broad skill",
        "recommendations: [documentation]",
        "restrictions:",
        "  allowed-tools: [read_file, write_file]",
        "permissions:",
        "  tools: [write_file]",
      ].join("\n"),
    );
    writeSkill(
      sourceRoot,
      "neutral-skill",
      "name: neutral-skill\ndescription: No additional restriction",
    );

    const catalog = await loadSkillCatalog(tmpDir, "code");
    const narrow = catalog.entries.find(
      (entry) => entry.name === "narrow-skill",
    )!;
    const broad = catalog.entries.find(
      (entry) => entry.name === "broad-skill",
    )!;
    const neutral = catalog.entries.find(
      (entry) => entry.name === "neutral-skill",
    )!;

    const firstOrder = composeSkillCapabilityPolicy([narrow, broad, neutral]);
    const secondOrder = composeSkillCapabilityPolicy([neutral, broad, narrow]);

    expect(firstOrder).toEqual(secondOrder);
    expect(firstOrder.allowedTools).toEqual(["read_file"]);
    expect(firstOrder.recommendations).toEqual([
      "documentation",
      "rich-output",
    ]);
    expect(firstOrder.requestedTools).toEqual([
      "execute_command",
      "write_file",
    ]);
    expect(firstOrder.dependencies).toEqual(narrow.resolvedDependencies);

    const afterNarrow = composeSkillCapabilityPolicy([narrow]);
    const afterBroaderLoad = composeSkillCapabilityPolicy([narrow, broad]);
    expect(afterNarrow.allowedTools).toEqual(["read_file"]);
    expect(afterBroaderLoad.allowedTools).toEqual(["read_file"]);
  });
});
