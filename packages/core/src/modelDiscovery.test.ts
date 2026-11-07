import { createModelDiscoveryTool, discoverModels } from "./modelDiscovery.js";
import { describe, expect, it, vi } from "vitest";

import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import type { HostToolExecutionContext } from "./hostTools.js";

const model: CoreModelCatalogEntry = {
  id: "local-model",
  displayName: "Distinct Model",
  providerId: "private-provider",
  providerDisplayName: "Personal Provider",
  contextWindow: 123456,
  maxOutputTokens: 4567,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "high",
  supportsToolUse: true,
  authenticated: false,
  readiness: {
    status: "credentials_required",
    reason: "secret raw error",
    action: { kind: "api_key", providerId: "private-provider" },
  },
};
const context = {
  principal: { tenantId: "tenant-a", subjectId: "principal-a" },
  sessionId: "session-a",
  turnId: "turn-a",
  model: {},
  signal: undefined,
} as HostToolExecutionContext;

describe("model discovery", () => {
  it("searches local identity using AND words and exact provider filters", () => {
    expect(discoverModels([model], { query: "PERSONAL distinct" }).total).toBe(
      1,
    );
    expect(discoverModels([model], { query: "distinct missing" }).total).toBe(
      0,
    );
    expect(
      discoverModels([model], { provider: "PRIVATE-provider" }).total,
    ).toBe(0);
    expect(discoverModels([model], { provider: model.providerId }).total).toBe(
      1,
    );
  });

  it("paginates without deduplicating colliding local IDs and preserves order", () => {
    const models = [model, { ...model, providerId: "second-provider" }];
    const first = discoverModels(models, { limit: 1 });
    expect(first).toMatchObject({
      total: 2,
      offset: 0,
      limit: 1,
      nextOffset: 1,
    });
    expect(
      discoverModels(models, { offset: first.nextOffset, limit: 1 }),
    ).toMatchObject({
      models: [{ providerId: "second-provider" }],
      total: 2,
    });
    expect(discoverModels(models, { offset: 2 }).nextOffset).toBeUndefined();
    expect(discoverModels([])).toMatchObject({
      models: [],
      total: 0,
      offset: 0,
      limit: 50,
    });
  });

  it("projects only allowlisted fields and conservative capability defaults", () => {
    const discovered = discoverModels([
      {
        ...model,
        endpoint: "https://secret.invalid",
        apiKey: "secret",
      } as CoreModelCatalogEntry,
    ]);
    expect(discovered.models[0]).toEqual({
      id: model.id,
      displayName: model.displayName,
      providerId: model.providerId,
      providerDisplayName: model.providerDisplayName,
      supportsToolUse: true,
      supportsImages: false,
      contextWindow: 123456,
      maxOutputTokens: 4567,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      authenticated: false,
      readiness: "credentials_required",
    });
    expect(JSON.stringify(discovered)).not.toContain("secret");
    expect(discovered.guidance).toContain(
      "not a list of arbitrary upstream models",
    );
    expect(discovered.guidance).toContain(
      "do not guarantee background-agent eligibility",
    );
    expect(
      discoverModels([{ ...model, readiness: undefined, authenticated: true }])
        .models[0]?.readiness,
    ).toBe("ready");
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { query: "x".repeat(501) },
  ])("rejects invalid bounds %j", (input) => {
    expect(() => discoverModels([model], input)).toThrow();
  });

  it("composes a live principal-scoped read tool and validates before reading", async () => {
    const listModels = vi.fn(
      async ({ principal }: HostToolExecutionContext) => [
        { ...model, id: principal.subjectId },
      ],
    );
    const tool = createModelDiscoveryTool({ listModels });
    expect(tool).toMatchObject({
      effect: "read",
      parallelSafe: true,
      authorization: "none",
    });
    await expect(tool.execute({ limit: 0 }, context)).rejects.toThrow();
    expect(listModels).not.toHaveBeenCalled();
    const result = await tool.execute({ query: "principal-a" }, context);
    expect(JSON.parse(result.modelContent as string)).toMatchObject({
      models: [{ id: "principal-a" }],
    });
    expect(listModels).toHaveBeenCalledWith(context);
    listModels.mockResolvedValueOnce([]);
    expect(
      JSON.parse((await tool.execute({}, context)).modelContent as string)
        .total,
    ).toBe(0);
  });

  it("does not expose provider exceptions", async () => {
    const tool = createModelDiscoveryTool({
      listModels: async () => {
        throw new Error("secret credential");
      },
    });
    const result = await tool.execute({}, context);
    expect(JSON.parse(result.modelContent as string)).toEqual({
      status: "model_catalog_unavailable",
      error:
        "The configured model catalog could not be read. Check provider configuration and try again.",
    });
    expect(result.isError).toBe(true);
  });
});
