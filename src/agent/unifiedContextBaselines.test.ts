import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  NATIVE_TOOL_SCHEMA_NAMES,
  STATIC_ADAPTER_TOOL_NAMES,
  getAgentTools,
} from "./toolAdapter.js";
import { TOOL_GROUPS, getToolsForMode } from "./toolPermissions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BUILT_IN_MODES } from "./modes.js";
import { TODO_TOOL_NAME } from "./todoTool.js";
import { TOOL_CAPABILITIES } from "../core/tools/toolCapabilities.js";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import { buildPromptArtifacts } from "./systemPrompt.js";
import { buildToolContextBreakdown } from "./contextBreakdown.js";
import { createHash } from "node:crypto";
import { createNativeToolDisclosureSnapshot } from "../core/tools/nativeToolDisclosure.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import { loadSkillsForModes } from "./skillLoader.js";

const fixtureRoot = path.resolve(
  __dirname,
  "..",
  "..",
  "fixtures",
  "unified-context-baselines",
  "v1",
);
const repoRoot = path.resolve(__dirname, "..", "..");
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const isolatedHome = path.join(os.tmpdir(), "agentlink-unified-context-home");

const providerCohorts = [
  { providerId: "anthropic", model: "claude-opus-4-8" },
  { providerId: "codex", model: "gpt-5.6-sol" },
  { providerId: "openai-compatible", model: "openai-compatible-eval" },
  { providerId: "gemini", model: "gemini-2.5-pro" },
] as const;
const promptProfiles = ["compatibility", "reasoning"] as const;

function readJson<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, name), "utf-8"),
  ) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePrompt(value: string): string {
  return value
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(isolatedHome, "<home>")
    .replace(/^[-] Git branch:.*$/gm, "- Git branch: <branch>")
    .replace(/^[-] Git status:.*$/gm, "- Git status: <status>")
    .replace(/^[-] OS:.*$/gm, "- OS: <os>")
    .replace(/^[-] Shell:.*$/gm, "- Shell: <shell>")
    .replace(/^[-] Home:.*$/gm, "- Home: <home>");
}

async function buildRuntimeMeasurements() {
  const prompts = [];
  const toolsByMode = [];
  const projectedToolsByMode = [];
  for (const mode of BUILT_IN_MODES) {
    const tools = getAgentTools(
      mode,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      ["search", "fetch"],
    );
    const toolBreakdown = buildToolContextBreakdown(tools);
    toolsByMode.push({
      mode: mode.slug,
      toolCount: tools.length,
      chars: toolBreakdown.totalChars,
      estimatedTokens: toolBreakdown.estimatedTokens,
      sha256: sha256(JSON.stringify(tools)),
    });
    const disclosure = createNativeToolDisclosureSnapshot(tools);
    const projectedToolBreakdown = buildToolContextBreakdown([
      ...disclosure.inlineTools,
    ]);
    projectedToolsByMode.push({
      mode: mode.slug,
      toolCount: disclosure.inlineTools.length,
      deferredToolCount: disclosure.deferredTools.length,
      chars: projectedToolBreakdown.totalChars,
      estimatedTokens: projectedToolBreakdown.estimatedTokens,
      sha256: sha256(JSON.stringify(disclosure.inlineTools)),
    });
    for (const cohort of providerCohorts) {
      for (const profile of promptProfiles) {
        const artifacts = await buildPromptArtifacts(mode.slug, fixtureRoot, {
          agentMode: mode,
          providerId: cohort.providerId,
          model: cohort.model,
          promptProfileOverrides: { [cohort.model]: profile },
          modeInstructionPlacement: "system",
        });
        const normalized = normalizePrompt(artifacts.systemPrompt);
        prompts.push({
          mode: mode.slug,
          providerId: cohort.providerId,
          model: cohort.model,
          profile: artifacts.promptProfile.profile,
          status: "measured",
          chars: normalized.length,
          estimatedTokens: estimateTokensFromChars(normalized.length),
          sha256: sha256(normalized),
          sectionLabels: artifacts.promptBreakdown.sections.map(
            (section) => section.label,
          ),
        });
      }
    }
  }

  const skills = await loadSkillsForModes(
    fixtureRoot,
    BUILT_IN_MODES.map((mode) => mode.slug),
  );
  const normalizedSkills = skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: normalizePrompt(skill.skillPath),
      allowedTools: skill.allowedTools ?? [],
      invocation: skill.invocation ?? "auto",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const skillCatalog = JSON.stringify(normalizedSkills);

  const adapterSource = fs.readFileSync(
    path.join(repoRoot, "src", "agent", "toolAdapter.ts"),
    "utf-8",
  );
  const dispatchSwitch = adapterSource.slice(
    adapterSource.indexOf("switch (toolName)"),
  );
  const dispatchNames = new Set(
    [...dispatchSwitch.matchAll(/^\s*case "([a-z_]+)"/gm)].map(
      (match) => match[1]!,
    ),
  );
  for (const name of [
    "web_search",
    "web_fetch",
    "find_native_tools",
    "call_native_tool",
    "compose",
    TODO_TOOL_NAME,
  ]) {
    dispatchNames.add(name);
  }
  const permissionNames = new Set(Object.values(TOOL_GROUPS).flat());
  const definitionModes = [
    undefined,
    ...BUILT_IN_MODES,
    {
      slug: "language-benchmark",
      name: "Language Benchmark",
      icon: "beaker",
      toolGroups: ["read", "language", "language-benchmark"],
    },
  ];
  const definitionNames = new Set([
    ...definitionModes.flatMap((mode) =>
      getAgentTools(
        mode,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        ["search", "fetch"],
      ).map((tool) => tool.name),
    ),
    TODO_TOOL_NAME,
  ]);
  const toolNames = new Set([
    ...Object.keys(TOOL_REGISTRY),
    ...NATIVE_TOOL_SCHEMA_NAMES,
    ...Object.keys(TOOL_CAPABILITIES),
    ...STATIC_ADAPTER_TOOL_NAMES,
    ...permissionNames,
    ...definitionNames,
    ...dispatchNames,
  ]);
  const toolInventory = [...toolNames].sort().map((name) => {
    const capability = TOOL_CAPABILITIES[name];
    const registrySchemaDefinition =
      capability?.definitionSource === "registry-schema";
    const staticModePermission =
      capability?.availability.kind === "mode-group" ||
      capability?.availability.kind === "benchmark-only";
    const engineInline = capability?.executionRoute === "engine-inline";
    return {
      name,
      registry: !registrySchemaDefinition || Object.hasOwn(TOOL_REGISTRY, name),
      schema: !registrySchemaDefinition || NATIVE_TOOL_SCHEMA_NAMES.has(name),
      permission: !staticModePermission || permissionNames.has(name),
      capability: capability !== undefined,
      definition: definitionNames.has(name),
      dispatch: engineInline
        ? name === TODO_TOOL_NAME
        : dispatchNames.has(name),
      availability: capability?.availability.kind,
      definitionSource: capability?.definitionSource,
      executionRoute: capability?.executionRoute,
      telemetryOwner: capability?.telemetryOwner,
      disclosure: capability?.disclosure,
    };
  });

  return {
    schemaVersion: 1,
    fixtureRevision: "unified-context-v1",
    prompts,
    toolsByMode,
    projectedToolsByMode,
    profileMatrix: {
      profiles: promptProfiles,
      status: "measured",
      modes: BUILT_IN_MODES.map((mode) => mode.slug),
      providerModels: providerCohorts,
    },
    skills: {
      count: normalizedSkills.length,
      catalogChars: skillCatalog.length,
      catalogEstimatedTokens: estimateTokensFromChars(skillCatalog.length),
      allowedToolsCount: normalizedSkills.filter(
        (skill) => skill.allowedTools.length > 0,
      ).length,
      manualCount: normalizedSkills.filter(
        (skill) => skill.invocation === "manual",
      ).length,
      sha256: sha256(skillCatalog),
    },
    toolInventory: {
      count: toolInventory.length,
      driftCount: toolInventory.filter(
        (tool) =>
          !tool.registry ||
          !tool.schema ||
          !tool.permission ||
          !tool.capability ||
          !tool.definition ||
          !tool.dispatch,
      ).length,
      missingBySource: Object.fromEntries(
        [
          "registry",
          "schema",
          "permission",
          "capability",
          "definition",
          "dispatch",
        ].map((source) => [
          source,
          toolInventory
            .filter(
              (tool) => !tool[source as keyof (typeof toolInventory)[number]],
            )
            .map((tool) => tool.name),
        ]),
      ),
      sha256: sha256(JSON.stringify(toolInventory)),
    },
  };
}

beforeAll(() => {
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  fs.mkdirSync(isolatedHome, { recursive: true });
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

describe("unified context Stage 0 baselines", () => {
  it("validates versioned acceptance, disposition, skill, retrieval, and memory fixture contracts", () => {
    const acceptance = readJson<{
      schemaVersion: number;
      fixtureRevision: string;
      profiles: string[];
      providerModelCohorts: Array<{
        id: string;
        providerId: string;
        model: string;
      }>;
      modes: string[];
      promptMatrix: {
        taskClasses: string[];
        workspaceInstructionCohorts: string[];
        mcpCohorts: string[];
        cacheCohorts: string[];
        minimumSamplesPerModelModeTaskCohort: number;
        maximumTaskSuccessRegressionPercentagePoints: number;
        allowSafetyApprovalOrStateRegression: boolean;
        requireCompositionBoundaryTestBeforeRemovingRuntimeMechanic: boolean;
      };
      postCondense: {
        sessionShapes: string[];
        minimumSamplesPerModelModeSessionShape: number;
        estimateGapP90MaxTokens: number;
        triggerTimingAbsoluteToleranceTokens: number;
      };
      implicitSkillActivation: {
        cohorts: Array<{
          id: string;
          precisionFloor: number;
          recallFloor: number;
        }>;
        explicitIdentityAndRevisionAccuracyFloor: number;
        minimumPositiveCasesPerCohort: number;
        minimumNegativeCasesPerCohort: number;
        maximumUnnecessaryLoadRate: number;
      };
      nativeToolDiscovery: {
        maximumTaskFailureRateAttributableToDiscovery: number;
        maximumMedianAdditionalRoundTrips: number;
        maximumP95AdditionalRoundTrips: number;
        minimumExecutableOrDiscoverableCoverage: number;
        minimumDisclosedAndAuthorizedAccuracy: number;
      };
      context: {
        combinedReasoningPromptAndNativeToolFloorMaxTokens: number;
        ordinaryTurnRecalledMemoryMaxTokens: number;
        omitMemoryBelowRetrievalThreshold: boolean;
      };
      retrieval: {
        minimumQualityVersusQdrantBaseline: number;
        requireImprovedExactPathIdentifierDiversity: boolean;
        compareRawBackendScores: boolean;
        requireStaleSourceSuppression: boolean;
      };
      memory: {
        allowContestedSupersededOrExpiredAutomaticReturn: boolean;
        conflictOutcome: string;
        allowContradictionBlending: boolean;
        requireLexicalOnlyCrudRecallDedupeConflictAuditUndo: boolean;
        requireExplicitLexicalOnlyHealth: boolean;
      };
      packaging: {
        requireAllSupportedTargetsBeforeQdrantRemoval: boolean;
      };
    }>("acceptance-bars.json");
    const disposition = readJson<{
      schemaVersion: number;
      fixtureRevision: string;
      sections: Array<{
        label: string;
        currentConcern: string;
        disposition: string;
        target: string;
        stage: number;
      }>;
    }>("prompt-disposition.json");
    const skillFixtures = readJson<{
      schemaVersion: number;
      fixtureRevision: string;
      activationStatus: string;
      triggerCases: Array<{
        id: string;
        cohort: string;
        prompt: string;
        expectedSkill: string | null;
        shouldLoad: boolean;
      }>;
      catalogCases: Array<{
        id: string;
        currentOutcome: string;
        targetOutcome: string;
      }>;
    }>("skill-fixtures.json");
    const retrievalFixtures = readJson<{
      schemaVersion: number;
      fixtureRevision: string;
      metrics: string[];
      surfaces: string[];
      queries: Array<{
        id: string;
        namespace: string;
        query: string;
        expectedRelevant: string[];
        exactIdentifiers?: string[];
        forbidden: string[];
      }>;
    }>("retrieval-fixtures.json");
    const memoryFixtures = readJson<{
      schemaVersion: number;
      fixtureRevision: string;
      executionStatus: string;
      cohorts: string[];
      cases: Array<{
        id: string;
        expected: Record<string, unknown>;
      }>;
    }>("memory-fixtures.json");
    const currentBaseline = readJson<{
      schemaVersion: number;
      fixtureRevision: string;
      capturedAt: string;
      privacy: string;
      codeRetrieval: {
        backend: string;
        capturedQueries: Array<{ queryId: string; rankedPaths: string[] }>;
        rawSimilarityScoresCommitted: boolean;
      };
    }>("current-baseline.json");

    const expectUniqueIds = (items: ReadonlyArray<{ id: string }>) => {
      expect(items.every((item) => item.id.length > 0)).toBe(true);
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    };
    const expectVersioned = (fixture: {
      schemaVersion: number;
      fixtureRevision: string;
    }) => {
      expect(fixture.schemaVersion).toBe(1);
      expect(fixture.fixtureRevision).toBe("unified-context-v1");
    };

    for (const fixture of [
      acceptance,
      disposition,
      skillFixtures,
      retrievalFixtures,
      memoryFixtures,
      currentBaseline,
    ]) {
      expectVersioned(fixture);
    }

    expect(acceptance.profiles).toEqual(["compatibility", "reasoning"]);
    expect(acceptance.modes).toEqual(BUILT_IN_MODES.map((mode) => mode.slug));
    expectUniqueIds(acceptance.providerModelCohorts);
    expect(acceptance.providerModelCohorts).toMatchObject([
      {
        id: "anthropic-flagship",
        providerId: "anthropic",
        model: "claude-opus-4-8",
      },
      {
        id: "codex-flagship",
        providerId: "codex",
        model: "gpt-5.6-sol",
      },
      {
        id: "openai-compatible",
        providerId: "openai-compatible",
        model: "openai-compatible-eval",
      },
      {
        id: "gemini-flagship",
        providerId: "gemini",
        model: "gemini-2.5-pro",
      },
    ]);
    expect(acceptance.promptMatrix).toMatchObject({
      taskClasses: [
        "small-bugfix",
        "multi-file-refactor",
        "architecture-plan",
        "tool-contract-docs",
      ],
      workspaceInstructionCohorts: ["none", "small", "large"],
      mcpCohorts: ["none", "small-inline", "large-deferred"],
      cacheCohorts: ["cold-first-turn", "warm-cached-turn"],
      minimumSamplesPerModelModeTaskCohort: 5,
      maximumTaskSuccessRegressionPercentagePoints: 2,
      allowSafetyApprovalOrStateRegression: false,
      requireCompositionBoundaryTestBeforeRemovingRuntimeMechanic: true,
    });
    expect(acceptance.postCondense).toMatchObject({
      sessionShapes: [
        "compact-conversation",
        "tool-result-heavy",
        "multi-tool-batch",
        "resumed-after-condense",
      ],
      minimumSamplesPerModelModeSessionShape: 5,
      estimateGapP90MaxTokens: 2_000,
      triggerTimingAbsoluteToleranceTokens: 2_000,
    });
    expectUniqueIds(acceptance.implicitSkillActivation.cohorts);
    expect(acceptance.implicitSkillActivation.cohorts).toMatchObject([
      {
        id: "explicit-domain-language",
        precisionFloor: 0.95,
        recallFloor: 0.9,
      },
      {
        id: "ambiguous-domain-language",
        precisionFloor: 0.9,
        recallFloor: 0.85,
      },
      {
        id: "negative-neighbor-tasks",
        precisionFloor: 0.95,
        recallFloor: 0.85,
      },
    ]);
    expect(acceptance.implicitSkillActivation).toMatchObject({
      explicitIdentityAndRevisionAccuracyFloor: 1,
      minimumPositiveCasesPerCohort: 20,
      minimumNegativeCasesPerCohort: 20,
      maximumUnnecessaryLoadRate: 0.05,
    });
    expect(acceptance.nativeToolDiscovery).toMatchObject({
      maximumTaskFailureRateAttributableToDiscovery: 0.05,
      maximumMedianAdditionalRoundTrips: 1,
      maximumP95AdditionalRoundTrips: 2,
      minimumExecutableOrDiscoverableCoverage: 1,
      minimumDisclosedAndAuthorizedAccuracy: 1,
    });
    expect(acceptance.context).toMatchObject({
      combinedReasoningPromptAndNativeToolFloorMaxTokens: 18_000,
      ordinaryTurnRecalledMemoryMaxTokens: 1_500,
      omitMemoryBelowRetrievalThreshold: true,
    });
    expect(acceptance.retrieval).toMatchObject({
      minimumQualityVersusQdrantBaseline: 1,
      requireImprovedExactPathIdentifierDiversity: true,
      compareRawBackendScores: false,
      requireStaleSourceSuppression: true,
    });
    expect(acceptance.memory).toMatchObject({
      allowContestedSupersededOrExpiredAutomaticReturn: false,
      conflictOutcome: "grounded-current-or-contested",
      allowContradictionBlending: false,
      requireLexicalOnlyCrudRecallDedupeConflictAuditUndo: true,
      requireExplicitLexicalOnlyHealth: true,
    });
    expect(acceptance.packaging).toMatchObject({
      requireAllSupportedTargetsBeforeQdrantRemoval: true,
    });

    expectUniqueIds(
      disposition.sections.map((section) => ({ id: section.label })),
    );
    expect(
      new Set(disposition.sections.map((section) => section.label)),
    ).toEqual(
      new Set([
        "base",
        "modes overview",
        "mode:*",
        "approve for me",
        "provider:*",
        "system info",
        "dev feedback",
        "custom instructions",
        "rule catalog (deferred)",
        "memory",
        "mode rules",
        "skills toc",
        "mcp tool catalog",
        "background agent",
        "native tool definitions",
      ]),
    );
    expect(
      disposition.sections.every(
        (section) =>
          section.currentConcern.length > 0 &&
          section.target.length > 0 &&
          ["keep", "split", "profile", "replace"].includes(
            section.disposition,
          ) &&
          section.stage >= 7 &&
          section.stage <= 10,
      ),
    ).toBe(true);

    expect(skillFixtures.activationStatus).toBe("future-oracle");
    expectUniqueIds(skillFixtures.triggerCases);
    expectUniqueIds(skillFixtures.catalogCases);
    expect(skillFixtures.triggerCases.map((testCase) => testCase.id)).toEqual([
      "explicit-rfc",
      "explicit-pr-description",
      "ambiguous-ui-toolkit",
      "negative-generic-typescript",
      "negative-markdown",
      "manual-only-not-invoked",
    ]);
    expect(
      skillFixtures.triggerCases.every(
        (testCase) =>
          testCase.prompt.length > 0 &&
          testCase.shouldLoad === (testCase.expectedSkill !== null),
      ),
    ).toBe(true);
    expect(skillFixtures.catalogCases.map((testCase) => testCase.id)).toEqual([
      "duplicate-name",
      "mode-incompatible-shadow",
      "two-allowed-tools",
      "restriction-mid-batch",
    ]);
    expect(
      skillFixtures.catalogCases.every(
        (testCase) =>
          testCase.currentOutcome.length > 0 &&
          testCase.targetOutcome.length > 0,
      ),
    ).toBe(true);

    expect(retrievalFixtures.surfaces).toEqual([
      "codebase_search",
      "search_files_semantic",
      "list_files_query",
      "read_file_query",
      "memory",
      "skill_rule",
      "native_tool",
      "session",
    ]);
    expect(retrievalFixtures.metrics).toEqual(
      expect.arrayContaining([
        "recallAtK",
        "mrr",
        "ndcg",
        "exactIdentifierRecall",
        "exactPathRecall",
        "staleSuppression",
        "sensitiveMemoryFalseNegativeRate",
      ]),
    );
    expectUniqueIds(retrievalFixtures.queries);
    expect(retrievalFixtures.queries.map((query) => query.id)).toEqual([
      "code-cart-total",
      "code-money-invoice",
      "stale-source",
      "memory-preference",
      "skill-rfc",
      "tool-definition",
      "session-recall",
    ]);
    expect(
      retrievalFixtures.queries.every(
        (query) =>
          query.namespace.length > 0 &&
          query.query.length > 0 &&
          Array.isArray(query.expectedRelevant) &&
          Array.isArray(query.forbidden),
      ),
    ).toBe(true);
    expect(
      retrievalFixtures.queries.find((query) => query.id === "stale-source"),
    ).toMatchObject({ expectedRelevant: [], forbidden: [expect.any(String)] });

    expect(memoryFixtures.executionStatus).toBe(
      "executable-repository-contract",
    );
    expect(memoryFixtures.cohorts).toEqual([
      "lexical-only-no-embedding",
      "hybrid-with-embedding",
    ]);
    expectUniqueIds(memoryFixtures.cases);
    expect(memoryFixtures.cases.map((testCase) => testCase.id)).toEqual([
      "crud-audit-undo",
      "exact-dedupe",
      "near-dedupe-lexical",
      "grounded-correction",
      "unresolved-conflict",
      "expired-memory",
      "irrelevant-memory",
      "secret-api-key",
      "imperative-low-authority",
      "lexical-only-health",
    ]);
    const memoryCase = (id: string) =>
      memoryFixtures.cases.find((testCase) => testCase.id === id)?.expected;
    expect(memoryCase("crud-audit-undo")).toMatchObject({
      auditComplete: true,
    });
    expect(memoryCase("grounded-correction")).toMatchObject({
      returned: "current",
      neverReturn: ["old"],
    });
    expect(memoryCase("unresolved-conflict")).toEqual({
      outcome: "contested",
      blend: false,
    });
    expect(memoryCase("expired-memory")).toEqual({ automaticReturn: false });
    expect(memoryCase("secret-api-key")).toEqual({
      persisted: false,
      auditDisposition: "rejected-sensitive",
    });
    expect(memoryCase("imperative-low-authority")).toEqual({
      rendering: "evidence-not-instruction",
      canAuthorizeTools: false,
    });
    expect(memoryCase("lexical-only-health")).toMatchObject({
      crud: true,
      bm25Recall: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      health: "lexical-only",
    });

    expect(currentBaseline.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(currentBaseline.privacy).toBe("aggregates-only");
    expect(currentBaseline.codeRetrieval.backend).toBe("legacy-qdrant");
    expect(currentBaseline.codeRetrieval.rawSimilarityScoresCommitted).toBe(
      false,
    );
    expect(
      currentBaseline.codeRetrieval.capturedQueries.map(
        (query) => query.queryId,
      ),
    ).toEqual(["code-cart-total", "code-money-invoice"]);
    expect(
      currentBaseline.codeRetrieval.capturedQueries.every(
        (query) => query.rankedPaths.length > 0,
      ),
    ).toBe(true);
  });

  it("matches deterministic prompt, tool, skill, and registry measurements", async () => {
    const measurements = await buildRuntimeMeasurements();

    expect(measurements.prompts).toHaveLength(
      BUILT_IN_MODES.length * providerCohorts.length * promptProfiles.length,
    );
    for (const profile of promptProfiles) {
      expect(
        measurements.prompts.filter((prompt) => prompt.profile === profile),
      ).toHaveLength(BUILT_IN_MODES.length * providerCohorts.length);
    }
    expect(measurements.toolInventory).toMatchObject({
      count: Object.keys(TOOL_CAPABILITIES).length,
      driftCount: 0,
      missingBySource: {
        registry: [],
        schema: [],
        permission: [],
        capability: [],
        definition: [],
        dispatch: [],
      },
    });
    const codeReasoningPromptTokens = Math.max(
      ...measurements.prompts
        .filter(
          (prompt) => prompt.mode === "code" && prompt.profile === "reasoning",
        )
        .map((prompt) => prompt.estimatedTokens),
    );
    const codeProjectedToolTokens = measurements.projectedToolsByMode.find(
      (measurement) => measurement.mode === "code",
    )?.estimatedTokens;
    expect(codeProjectedToolTokens).toBeDefined();
    expect(
      codeReasoningPromptTokens + codeProjectedToolTokens!,
    ).toBeLessThanOrEqual(18_000);
    expect(measurements).toEqual(readJson("runtime-measurements.json"));
  }, 15_000);

  it("keeps every built-in mode permission resolvable", () => {
    for (const mode of BUILT_IN_MODES) {
      expect([...getToolsForMode(mode)].length, mode.slug).toBeGreaterThan(0);
    }
  });
});
