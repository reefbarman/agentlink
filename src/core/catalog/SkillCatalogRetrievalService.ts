import type {
  RetrievalPublicationOutcome,
  RetrievalPublicationRequest,
} from "@agentlink/protocol/retrieval-publication";

import type { RetrievalHealthReason } from "@agentlink/protocol/retrieval-health";
import type { RetrievalRepository } from "../retrieval/contracts.js";

const SKILL_CATALOG_DOMAIN = "skill-catalog";
const SKILL_CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_RECALL_LIMIT = 8;
const MAX_RECALL_LIMIT = 50;
let publicationSequence = 0;

export interface SkillCatalogFallbackEntry {
  id: string;
  name: string;
  description: string;
  revision: string;
  invocation?: "auto" | "manual";
  recommendations?: string[];
}

export interface SkillCatalogAuthorityEntry {
  id: string;
  name: string;
  description: string;
  revision: string;
  skillPath: string;
  realSkillPath: string;
  enabled: boolean;
  invocation?: "auto" | "manual";
}

export interface PublishSkillCatalogFallbackRequest {
  publisherId: string;
  projectId: string;
  catalogRevision: string;
  observedAt: string;
  entries: SkillCatalogFallbackEntry[];
}

export type SkillCatalogFallbackPublishResult =
  | {
      status: "published" | "unchanged" | "stale_source";
      sourceId: string;
      revisionId: string;
    }
  | {
      status: "unavailable";
      reason: RetrievalHealthReason;
      detail?: string;
    };

export interface RecallSkillCatalogFallbackRequest {
  query: string;
  projectId: string;
  omissions: readonly Pick<SkillCatalogFallbackEntry, "id" | "revision">[];
  authority: readonly SkillCatalogAuthorityEntry[];
  limit?: number;
}

export interface SkillCatalogFallbackResult {
  id: string;
  name: string;
  description: string;
  revision: string;
  skillPath: string;
  realSkillPath: string;
  invocation?: "auto" | "manual";
  score: number;
}

export interface SkillCatalogRetrievalServiceOptions {
  createPublicationId?: () => string;
}

export class SkillCatalogRetrievalService {
  private readonly createPublicationId: () => string;

  constructor(
    private readonly repository: RetrievalRepository,
    options: SkillCatalogRetrievalServiceOptions = {},
  ) {
    this.createPublicationId =
      options.createPublicationId ??
      (() =>
        `skill-catalog-publication-${Date.now()}-${++publicationSequence}`);
  }

  async publishFallback(
    request: PublishSkillCatalogFallbackRequest,
  ): Promise<SkillCatalogFallbackPublishResult> {
    validatePublication(request);
    const readiness = await this.repository.lexicalReadiness();
    if (readiness.status === "unavailable") return readiness;

    const sourceId = getSkillCatalogFallbackSourceId(request);
    const entries = [...request.entries].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const contentHash = stableHash(stableStringify(entries));
    const revisionId = `skill-catalog:${contentHash}`;
    const active = await this.repository.inspectSource(sourceId);
    if (active?.source.revision.contentHash === contentHash) {
      return { status: "unchanged", sourceId, revisionId };
    }

    const publication = buildPublication(
      request,
      entries,
      sourceId,
      revisionId,
      contentHash,
      nextObservedAt(request.observedAt, active?.source.revision.observedAt),
      this.createPublicationId(),
    );
    await this.repository.preparePublication(publication);
    let outcome: RetrievalPublicationOutcome;
    try {
      outcome = await this.repository.commitPublication(
        publication.publicationId,
      );
    } catch (error) {
      await this.repository
        .abortPublication(publication.publicationId)
        .catch(() => undefined);
      throw error;
    }
    if (outcome.status === "published" || outcome.status === "stale_source") {
      return { status: outcome.status, sourceId, revisionId };
    }
    throw new Error(
      `Skill catalog fallback publication failed: ${outcome.status}`,
    );
  }

  async recallFallback(
    request: RecallSkillCatalogFallbackRequest,
  ): Promise<SkillCatalogFallbackResult[]> {
    const query = request.query.trim();
    if (!query || request.omissions.length === 0) return [];
    validateIdentity("project ID", request.projectId);
    const limit = request.limit ?? DEFAULT_RECALL_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECALL_LIMIT) {
      throw new Error(
        `Skill catalog fallback recall limit must be an integer from 1 to ${MAX_RECALL_LIMIT}`,
      );
    }

    const readiness = await this.repository.lexicalReadiness();
    if (readiness.status === "unavailable") return [];
    const omitted = new Set(
      request.omissions.map((entry) =>
        skillRevisionKey(entry.id, entry.revision),
      ),
    );
    const authority = new Map(
      request.authority
        .filter((entry) => entry.enabled)
        .map((entry) => [skillRevisionKey(entry.id, entry.revision), entry]),
    );
    const result = await this.repository.query({
      text: query,
      mode: "lexical",
      filters: {
        namespaces: ["catalog"],
        sourceKinds: ["skill"],
        metadata: {
          domain: SKILL_CATALOG_DOMAIN,
          scopeKind: "project",
          scopeId: request.projectId,
        },
      },
      limit: Math.max(limit * 4, 20),
      freshness: "index_only",
      diversity: { maxPerSource: limit, collapseOverlaps: true },
    });

    const seen = new Set<string>();
    return result.candidates
      .flatMap((candidate) => {
        const skillId = stringMetadata(candidate.chunk.metadata.skillId);
        const skillRevision = stringMetadata(
          candidate.chunk.metadata.skillRevision,
        );
        if (!skillId || !skillRevision) return [];
        const key = skillRevisionKey(skillId, skillRevision);
        if (seen.has(key) || !omitted.has(key)) return [];
        const current = authority.get(key);
        if (!current) return [];
        seen.add(key);
        return [
          {
            id: current.id,
            name: current.name,
            description: current.description,
            revision: current.revision,
            skillPath: current.skillPath,
            realSkillPath: current.realSkillPath,
            ...(current.invocation ? { invocation: current.invocation } : {}),
            score: candidate.scores.final,
          },
        ];
      })
      .slice(0, limit);
  }

  async clearFallback(request: {
    publisherId: string;
    projectId: string;
  }): Promise<"deleted" | "not_found" | "unavailable"> {
    validateIdentity("publisher ID", request.publisherId);
    validateIdentity("project ID", request.projectId);
    const readiness = await this.repository.lexicalReadiness();
    if (readiness.status === "unavailable") return "unavailable";
    const outcome = await this.repository.deleteSource({
      sourceId: getSkillCatalogFallbackSourceId(request),
    });
    return outcome.status === "stale_source" ? "not_found" : outcome.status;
  }
}

export function getSkillCatalogFallbackSourceId(request: {
  publisherId: string;
  projectId: string;
}): string {
  return [
    "catalog",
    "skill",
    encodeURIComponent(request.publisherId),
    encodeURIComponent(request.projectId),
  ].join(":");
}

function buildPublication(
  request: PublishSkillCatalogFallbackRequest,
  entries: SkillCatalogFallbackEntry[],
  sourceId: string,
  revisionId: string,
  contentHash: string,
  observedAt: string,
  publicationId: string,
): RetrievalPublicationRequest {
  const generation = `skill-catalog-generation:${contentHash}`;
  const chunks = entries.map((entry) => ({
    id: `${sourceId}:skill:${encodeURIComponent(entry.id)}`,
    sourceId,
    revisionId,
    generation,
    content: renderSearchText(entry),
    embedding: null,
    metadata: {
      domain: SKILL_CATALOG_DOMAIN,
      recordKind: "skill-metadata",
      scopeKind: "project",
      scopeId: request.projectId,
      publisherId: request.publisherId,
      catalogRevision: request.catalogRevision,
      skillId: entry.id,
      skillRevision: entry.revision,
      skillName: entry.name,
    },
  }));
  return {
    publicationId,
    generation,
    source: {
      id: sourceId,
      namespace: "catalog",
      kind: "skill",
      revision: { id: revisionId, contentHash, observedAt },
      title: "Deferred skill catalog metadata",
      content: entries.map(renderSearchText).join("\n\n"),
      metadata: {
        domain: SKILL_CATALOG_DOMAIN,
        schemaVersion: SKILL_CATALOG_SCHEMA_VERSION,
        scopeKind: "project",
        scopeId: request.projectId,
        publisherId: request.publisherId,
        catalogRevision: request.catalogRevision,
        entryCount: entries.length,
      },
    },
    chunks,
    relations: [],
    expectedChunkIds: chunks.map((chunk) => chunk.id),
    expectedRelationIds: [],
  };
}

function renderSearchText(entry: SkillCatalogFallbackEntry): string {
  return [
    entry.name,
    entry.description,
    entry.id,
    ...(entry.recommendations ?? []),
    ...(entry.invocation ? [entry.invocation] : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

function validatePublication(
  request: PublishSkillCatalogFallbackRequest,
): void {
  validateIdentity("publisher ID", request.publisherId);
  validateIdentity("project ID", request.projectId);
  validateIdentity("catalog revision", request.catalogRevision);
  if (!Number.isFinite(Date.parse(request.observedAt))) {
    throw new Error("Skill catalog fallback observedAt is invalid");
  }
  if (request.entries.length === 0) {
    throw new Error(
      "Skill catalog fallback requires at least one omitted entry",
    );
  }
  const identities = new Set<string>();
  for (const entry of request.entries) {
    validateIdentity("skill ID", entry.id);
    validateIdentity("skill name", entry.name);
    validateIdentity("skill revision", entry.revision);
    if (!entry.description.trim()) {
      throw new Error(
        `Skill catalog fallback description is required: ${entry.id}`,
      );
    }
    if (identities.has(entry.id)) {
      throw new Error(`Duplicate skill catalog fallback ID: ${entry.id}`);
    }
    identities.add(entry.id);
  }
}

function validateIdentity(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function nextObservedAt(requested: string, current?: string): string {
  const requestedTime = Date.parse(requested);
  const currentTime = current ? Date.parse(current) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(requestedTime, currentTime + 1)).toISOString();
}

function skillRevisionKey(id: string, revision: string): string {
  return `${id}\u0000${revision}`;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
