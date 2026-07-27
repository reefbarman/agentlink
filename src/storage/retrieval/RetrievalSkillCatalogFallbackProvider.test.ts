import { describe, expect, it, vi } from "vitest";

import { RetrievalSkillCatalogFallbackProvider } from "./RetrievalSkillCatalogFallbackProvider.js";
import type { SkillCatalogRetrievalService } from "../../core/catalog/SkillCatalogRetrievalService.js";

function publication(publisherId: string, entries = [entry()]) {
  return {
    publisherId,
    projectId: "project-a",
    catalogRevision: `catalog-${publisherId}`,
    observedAt: "2026-07-26T00:00:00.000Z",
    entries,
  };
}

function entry() {
  return {
    id: "project:agentlink:.agentlink/skills/helper",
    name: "helper",
    description: "Helper metadata",
    revision: "skill-revision",
  };
}

function harness() {
  const publishFallback = vi.fn(async () => ({ status: "published" as const }));
  const clearFallback = vi.fn(async () => "deleted" as const);
  const service = {
    publishFallback,
    clearFallback,
  } as unknown as SkillCatalogRetrievalService;
  return {
    provider: new RetrievalSkillCatalogFallbackProvider(
      service,
      "vscode:window",
    ),
    publishFallback,
    clearFallback,
  };
}

describe("RetrievalSkillCatalogFallbackProvider", () => {
  it("scopes independent session publications and clears empty projections", async () => {
    const { provider, publishFallback, clearFallback } = harness();

    await provider.update(publication("session-a"));
    await provider.update(publication("session-b"));
    await provider.update(publication("session-a", []));

    expect(publishFallback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        publisherId: "vscode:window:session-a",
        projectId: "project-a",
      }),
    );
    expect(publishFallback).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        publisherId: "vscode:window:session-b",
        projectId: "project-a",
      }),
    );
    expect(clearFallback).toHaveBeenCalledWith({
      publisherId: "vscode:window:session-a",
      projectId: "project-a",
    });
  });

  it("serializes update and removal for the same session", async () => {
    let releasePublish!: () => void;
    const publishPending = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const events: string[] = [];
    const publishFallback = vi.fn(async () => {
      events.push("publish:start");
      await publishPending;
      events.push("publish:end");
      return { status: "published" as const };
    });
    const clearFallback = vi.fn(async () => {
      events.push("clear");
      return "deleted" as const;
    });
    const provider = new RetrievalSkillCatalogFallbackProvider(
      {
        publishFallback,
        clearFallback,
      } as unknown as SkillCatalogRetrievalService,
      "vscode:window",
    );

    const update = provider.update(publication("session-a"));
    await vi.waitFor(() => expect(events).toEqual(["publish:start"]));
    const remove = provider.remove({
      publisherId: "session-a",
      projectId: "project-a",
    });
    expect(events).toEqual(["publish:start"]);

    releasePublish();
    await Promise.all([update, remove]);
    expect(events).toEqual(["publish:start", "publish:end", "clear"]);
  });

  it("continues the per-session queue after a rejected operation", async () => {
    const publishFallback = vi
      .fn()
      .mockRejectedValueOnce(new Error("publish failed"))
      .mockResolvedValueOnce({ status: "published" as const });
    const clearFallback = vi.fn(async () => "deleted" as const);
    const provider = new RetrievalSkillCatalogFallbackProvider(
      {
        publishFallback,
        clearFallback,
      } as unknown as SkillCatalogRetrievalService,
      "vscode:window",
    );

    await expect(provider.update(publication("session-a"))).rejects.toThrow(
      "publish failed",
    );
    await expect(
      provider.update(publication("session-a")),
    ).resolves.toBeUndefined();
    expect(publishFallback).toHaveBeenCalledTimes(2);
  });

  it("retries an unavailable removal during disposal", async () => {
    const publishFallback = vi.fn(async () => ({
      status: "published" as const,
    }));
    const clearFallback = vi
      .fn()
      .mockResolvedValueOnce("unavailable" as const)
      .mockResolvedValueOnce("deleted" as const);
    const provider = new RetrievalSkillCatalogFallbackProvider(
      {
        publishFallback,
        clearFallback,
      } as unknown as SkillCatalogRetrievalService,
      "vscode:window",
    );
    await provider.update(publication("session-a"));

    await provider.remove({
      publisherId: "session-a",
      projectId: "project-a",
    });
    await provider.dispose();

    expect(clearFallback).toHaveBeenCalledTimes(2);
  });

  it("retries a failed removal during disposal", async () => {
    const publishFallback = vi.fn(async () => ({
      status: "published" as const,
    }));
    const clearFallback = vi
      .fn()
      .mockRejectedValueOnce(new Error("store busy"))
      .mockResolvedValueOnce("deleted" as const);
    const provider = new RetrievalSkillCatalogFallbackProvider(
      {
        publishFallback,
        clearFallback,
      } as unknown as SkillCatalogRetrievalService,
      "vscode:window",
    );
    await provider.update(publication("session-a"));

    await expect(
      provider.remove({
        publisherId: "session-a",
        projectId: "project-a",
      }),
    ).rejects.toThrow("store busy");
    await provider.dispose();

    expect(clearFallback).toHaveBeenCalledTimes(2);
    expect(clearFallback).toHaveBeenLastCalledWith({
      publisherId: "vscode:window:session-a",
      projectId: "project-a",
    });
  });

  it("clears tracked sources once on disposal and ignores later mutations", async () => {
    const { provider, publishFallback, clearFallback } = harness();
    await provider.update(publication("session-a"));
    await provider.update(publication("session-b"));

    const firstDispose = provider.dispose();
    const secondDispose = provider.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;

    expect(clearFallback).toHaveBeenCalledWith({
      publisherId: "vscode:window:session-a",
      projectId: "project-a",
    });
    expect(clearFallback).toHaveBeenCalledWith({
      publisherId: "vscode:window:session-b",
      projectId: "project-a",
    });
    expect(clearFallback).toHaveBeenCalledTimes(2);

    await provider.update(publication("session-c"));
    await provider.remove({
      publisherId: "session-c",
      projectId: "project-a",
    });
    expect(publishFallback).toHaveBeenCalledTimes(2);
    expect(clearFallback).toHaveBeenCalledTimes(2);
  });
});
