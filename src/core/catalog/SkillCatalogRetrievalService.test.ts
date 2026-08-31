import { describe, expect, it, vi } from "vitest";

import type { RetrievalFingerprint } from "@agentlink/protocol/retrieval-fingerprint";
import { InMemoryRetrievalRepository } from "../retrieval/InMemoryRetrievalRepository.js";
import {
  SkillCatalogRetrievalService,
  getSkillCatalogFallbackSourceId,
  type PublishSkillCatalogFallbackRequest,
  type SkillCatalogAuthorityEntry,
  type SkillCatalogFallbackEntry,
} from "./SkillCatalogRetrievalService.js";

const fingerprint: RetrievalFingerprint = {
  schemaVersion: 1,
  recordSchemaVersion: 1,
  relationSchemaVersion: 1,
  chunker: {
    id: "skill-catalog-test",
    version: 1,
    configurationHash: "skill-catalog-test-v1",
  },
  embedding: null,
};

function entry(
  id: string,
  overrides: Partial<SkillCatalogFallbackEntry> = {},
): SkillCatalogFallbackEntry {
  return {
    id,
    name: overrides.name ?? id.split(":").at(-1) ?? id,
    description: overrides.description ?? `${id} workflow metadata`,
    revision: overrides.revision ?? `${id}-revision`,
    invocation: overrides.invocation,
    recommendations: overrides.recommendations,
  };
}

function authority(
  fallback: SkillCatalogFallbackEntry,
  overrides: Partial<SkillCatalogAuthorityEntry> = {},
): SkillCatalogAuthorityEntry {
  return {
    id: fallback.id,
    name: fallback.name,
    description: fallback.description,
    revision: fallback.revision,
    skillPath: `/current/${encodeURIComponent(fallback.id)}/SKILL.md`,
    realSkillPath: `/real/${encodeURIComponent(fallback.id)}/SKILL.md`,
    enabled: true,
    invocation: fallback.invocation,
    ...overrides,
  };
}

function publication(
  entries: SkillCatalogFallbackEntry[],
  overrides: Partial<PublishSkillCatalogFallbackRequest> = {},
): PublishSkillCatalogFallbackRequest {
  return {
    publisherId: "window-one",
    projectId: "project-one",
    catalogRevision: "catalog-one",
    observedAt: "2026-07-26T00:00:00.000Z",
    entries,
    ...overrides,
  };
}

function service(options: { initialized?: boolean } = {}) {
  const repository = new InMemoryRetrievalRepository({
    embeddingConfigured: false,
    ...(options.initialized === false ? {} : { fingerprint }),
  });
  let publicationId = 0;
  return {
    repository,
    service: new SkillCatalogRetrievalService(repository, {
      createPublicationId: () => `publication-${++publicationId}`,
    }),
  };
}

describe("SkillCatalogRetrievalService", () => {
  it("publishes metadata-only omitted skills with null embeddings", async () => {
    const { repository, service: catalog } = service();
    const entries = [
      entry("project:agentlink:alpha", {
        description: "Alpha browser automation workflow",
        invocation: "manual",
        recommendations: ["browser", "automation"],
      }),
      entry("project:agentlink:beta", {
        description: "Beta documentation workflow",
      }),
    ];
    const request = publication(entries);

    await expect(catalog.publishFallback(request)).resolves.toMatchObject({
      status: "published",
      sourceId: getSkillCatalogFallbackSourceId(request),
    });

    const source = await repository.inspectSource(
      getSkillCatalogFallbackSourceId(request),
    );
    expect(source).toMatchObject({
      source: {
        namespace: "catalog",
        kind: "skill",
        metadata: {
          domain: "skill-catalog",
          scopeKind: "project",
          scopeId: "project-one",
          publisherId: "window-one",
          catalogRevision: "catalog-one",
          entryCount: 2,
        },
      },
    });
    const candidates = await repository.query({
      text: "browser automation",
      mode: "lexical",
      filters: {
        namespaces: ["catalog"],
        sourceKinds: ["skill"],
        metadata: { domain: "skill-catalog", scopeId: "project-one" },
      },
      limit: 10,
    });
    expect(candidates.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunk: expect.objectContaining({
            embedding: null,
            metadata: expect.objectContaining({
              skillId: "project:agentlink:alpha",
              skillRevision: "project:agentlink:alpha-revision",
            }),
          }),
        }),
      ]),
    );
  });

  it("aborts a prepared publication when commit fails", async () => {
    const { repository, service: catalog } = service();
    const abortPublication = vi.spyOn(repository, "abortPublication");
    vi.spyOn(repository, "commitPublication").mockRejectedValueOnce(
      new Error("commit failed"),
    );

    await expect(
      catalog.publishFallback(
        publication([entry("project:agentlink:commit-failure")]),
      ),
    ).rejects.toThrow("commit failed");
    expect(abortPublication).toHaveBeenCalledWith("publication-1");
    expect(await repository.listSources()).toEqual([]);
  });

  it("no-ops identical projections and atomically replaces changed entries", async () => {
    const { repository, service: catalog } = service();
    const first = entry("project:agentlink:first", {
      description: "First retained metadata",
    });
    const request = publication([first]);

    await expect(catalog.publishFallback(request)).resolves.toMatchObject({
      status: "published",
    });
    const metrics = repository.metrics();
    await expect(catalog.publishFallback(request)).resolves.toMatchObject({
      status: "unchanged",
    });
    expect(repository.metrics()).toEqual(metrics);

    const second = entry("project:agentlink:second", {
      description: "Second replacement metadata",
    });
    await expect(
      catalog.publishFallback(
        publication([second], {
          catalogRevision: "catalog-two",
          observedAt: request.observedAt,
        }),
      ),
    ).resolves.toMatchObject({ status: "published" });

    expect(
      (
        await repository.query({
          text: "First retained",
          mode: "lexical",
          limit: 10,
        })
      ).candidates,
    ).toEqual([]);
    expect(
      (
        await repository.query({
          text: "Second replacement",
          mode: "lexical",
          limit: 10,
        })
      ).candidates.map((candidate) => candidate.chunk.metadata.skillId),
    ).toEqual([second.id]);
  });

  it("re-authorizes duplicate names by exact omission and current revision", async () => {
    const { service: catalog } = service();
    const agentlink = entry("project:agentlink:.agentlink/skills/shared", {
      name: "shared",
      description: "Shared browser automation workflow",
      revision: "agentlink-revision",
    });
    const claude = entry("project:claude:.claude/skills/shared", {
      name: "shared",
      description: "Shared browser diagnostics workflow",
      revision: "claude-revision",
    });
    await catalog.publishFallback(publication([agentlink, claude]));

    const currentAgentlink = authority(agentlink, {
      skillPath: "/current/agentlink/shared/SKILL.md",
      realSkillPath: "/real/agentlink/shared/SKILL.md",
    });
    const staleClaude = authority(claude, {
      revision: "newer-claude-revision",
      skillPath: "/current/claude/shared/SKILL.md",
      realSkillPath: "/real/claude/shared/SKILL.md",
    });
    const recalled = await catalog.recallFallback({
      query: "shared browser workflow",
      projectId: "project-one",
      omissions: [agentlink, claude],
      authority: [currentAgentlink, staleClaude],
      limit: 10,
    });

    expect(recalled).toEqual([
      expect.objectContaining({
        id: agentlink.id,
        revision: agentlink.revision,
        skillPath: "/current/agentlink/shared/SKILL.md",
        realSkillPath: "/real/agentlink/shared/SKILL.md",
      }),
    ]);
  });

  it("rejects non-omitted, disabled, stale, and cross-project retrieval hits", async () => {
    const { service: catalog } = service();
    const allowed = entry("project:agentlink:allowed", {
      description: "Allowed release workflow",
    });
    const notOmitted = entry("project:agentlink:not-omitted", {
      description: "Not omitted release workflow",
    });
    const otherProject = entry("project:agentlink:other-project", {
      description: "Other project release workflow",
    });
    await catalog.publishFallback(publication([allowed, notOmitted]));
    await catalog.publishFallback(
      publication([otherProject], {
        publisherId: "window-two",
        projectId: "project-two",
      }),
    );

    await expect(
      catalog.recallFallback({
        query: "release workflow",
        projectId: "project-one",
        omissions: [allowed],
        authority: [
          authority(allowed, { enabled: false }),
          authority(notOmitted),
        ],
      }),
    ).resolves.toEqual([]);
  });

  it("isolates publisher cleanup while project recall remains session-authorized", async () => {
    const { repository, service: catalog } = service();
    const first = entry("project:agentlink:first", {
      description: "First deployment helper",
    });
    const second = entry("project:agentlink:second", {
      description: "Second deployment helper",
    });
    await catalog.publishFallback(publication([first]));
    await catalog.publishFallback(
      publication([second], { publisherId: "window-two" }),
    );

    expect(
      await catalog.recallFallback({
        query: "deployment helper",
        projectId: "project-one",
        omissions: [second],
        authority: [authority(first), authority(second)],
      }),
    ).toEqual([expect.objectContaining({ id: second.id })]);

    await expect(
      catalog.clearFallback({
        publisherId: "window-one",
        projectId: "project-one",
      }),
    ).resolves.toBe("deleted");
    await expect(
      repository.inspectSource(
        getSkillCatalogFallbackSourceId({
          publisherId: "window-one",
          projectId: "project-one",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      repository.inspectSource(
        getSkillCatalogFallbackSourceId({
          publisherId: "window-two",
          projectId: "project-one",
        }),
      ),
    ).resolves.not.toBeNull();
  });

  it("degrades safely when the lexical store is not initialized", async () => {
    const { repository, service: catalog } = service({ initialized: false });
    const omitted = entry("project:agentlink:omitted");

    await expect(
      catalog.publishFallback(publication([omitted])),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "missing_index",
    });
    await expect(
      catalog.recallFallback({
        query: "workflow metadata",
        projectId: "project-one",
        omissions: [omitted],
        authority: [authority(omitted)],
      }),
    ).resolves.toEqual([]);
    expect(await repository.listSources()).toEqual([]);
    expect(repository.metrics().sourcesScanned).toBe(0);
  });
});
