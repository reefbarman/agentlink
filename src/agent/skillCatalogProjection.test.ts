import { describe, expect, it } from "vitest";
import {
  projectSkillCatalog,
  resolveSkillCatalogBudgetChars,
} from "./skillCatalogProjection.js";

import type { SkillEntry } from "./skillLoader.js";

function skill(id: string, options: Partial<SkillEntry> = {}): SkillEntry {
  const name = options.name ?? id.split("/").at(-1) ?? id;
  const skillPath =
    options.skillPath ?? `/workspace/.agentlink/skills/${name}/SKILL.md`;
  return {
    id,
    name,
    description: options.description ?? `${name} description`,
    revision: options.revision ?? id.padEnd(64, "a").slice(0, 64),
    sourceChars: options.sourceChars ?? 512,
    provenance: options.provenance ?? {
      scope: "project",
      namespace: "agentlink",
      sourceRoot: "/workspace/.agentlink/skills",
      skillDirectory: `/workspace/.agentlink/skills/${name}`,
      realSkillPath: skillPath,
      priority: 1,
    },
    skillPath,
    allowedTools: options.allowedTools,
    restrictions: options.restrictions ?? {
      allowedTools: options.allowedTools,
    },
    permissions: options.permissions ?? { requestedTools: [] },
    dependencies: options.dependencies ?? [],
    recommendations: options.recommendations ?? [],
    resolvedDependencies: options.resolvedDependencies ?? [],
    invocation: options.invocation,
    enabled: options.enabled ?? true,
    disabledReason: options.disabledReason,
  };
}

describe("skill catalog projection", () => {
  it("resolves a bounded context-aware budget with deterministic overrides", () => {
    expect(resolveSkillCatalogBudgetChars()).toBe(8_000);
    expect(resolveSkillCatalogBudgetChars(200_000)).toBe(8_000);
    expect(resolveSkillCatalogBudgetChars(8_000)).toBe(1_024);
    expect(resolveSkillCatalogBudgetChars(200_000, 321.9)).toBe(321);
    expect(resolveSkillCatalogBudgetChars(200_000, -1)).toBe(0);
  });

  it("renders canonical identities deterministically without collapsing duplicate names", () => {
    const first = skill("project:agentlink:a/shared", { name: "shared" });
    const second = skill("global:agentlink:b/shared", { name: "shared" });

    const left = projectSkillCatalog([first, second], "/workspace", 8_000);
    const right = projectSkillCatalog([second, first], "/workspace", 8_000);

    expect(left).toEqual(right);
    expect(left.advertised.map((entry) => entry.id)).toEqual([
      "global:agentlink:b/shared",
      "project:agentlink:a/shared",
    ]);
    expect(left.catalogXml.match(/name="shared"/g)).toHaveLength(2);
    expect(left.catalogXml).toContain(`id="${first.id}"`);
    expect(left.catalogXml).toContain(`revision="${first.revision}"`);
  });

  it("shortens descriptions before omitting entries and reports every omission", () => {
    const entries = [
      skill("project:agentlink:a", {
        description: "A".repeat(300),
        sourceChars: 1_000,
      }),
      skill("project:agentlink:b", {
        description: "B".repeat(300),
        sourceChars: 2_000,
      }),
      skill("project:agentlink:c", {
        description: "C".repeat(300),
        sourceChars: 3_000,
      }),
    ];
    const budget = 650;
    const projected = projectSkillCatalog(entries, "/workspace", budget);

    expect(projected.renderedChars).toBeLessThanOrEqual(budget);
    expect(projected.truncatedCount).toBeGreaterThan(0);
    expect(projected.omittedCount).toBeGreaterThan(0);
    expect(projected.omissions).toEqual(
      entries.slice(projected.advertisedCount).map((entry) => ({
        id: entry.id,
        name: entry.name,
        revision: entry.revision,
        reason: "budget",
      })),
    );
    expect(projected.retrievalFallbackRequired).toBe(true);
  });

  it("preserves exact authorized paths and records deferred source characters", () => {
    const exactPath = "/workspace/.agentlink/skills/helper/SKILL.md";
    const projected = projectSkillCatalog(
      [
        skill("project:agentlink:helper", {
          skillPath: exactPath,
          sourceChars: 1_234,
          invocation: "manual",
          allowedTools: ["read_file"],
        }),
      ],
      "/workspace",
      8_000,
    );

    expect(projected.advertised[0]).toMatchObject({
      loadPath: exactPath,
      deferredChars: 1_234,
      invocation: "manual",
      allowedTools: ["read_file"],
      pathShortened: false,
    });
    expect(projected.sourceChars).toBe(1_234);
    expect(projected.deferredChars).toBe(1_234);
    expect(projected.catalogXml).toContain(`path="${exactPath}"`);
    expect(projected.catalogXml).toContain('deferred-chars="1234"');
  });

  it("excludes disabled skills and escapes metadata safely", () => {
    const projected = projectSkillCatalog(
      [
        skill("project:agentlink:enabled", {
          name: "enabled",
          description: `Use <xml> & "quotes"`,
        }),
        skill("project:agentlink:disabled", {
          enabled: false,
          disabledReason: "configuration",
        }),
      ],
      "/workspace",
      8_000,
    );

    expect(projected.discoveredCount).toBe(2);
    expect(projected.enabledCount).toBe(1);
    expect(projected.catalogXml).toContain(
      "Use &lt;xml&gt; &amp; &quot;quotes&quot;",
    );
    expect(projected.catalogXml).not.toContain("project:agentlink:disabled");
  });
});
