import * as path from "path";

import type { SkillEntry } from "./skillLoader.js";
import { createHash } from "crypto";

const DEFAULT_SKILL_CATALOG_BUDGET_CHARS = 8_000;
const MIN_SKILL_CATALOG_BUDGET_CHARS = 1_024;
const SKILL_CATALOG_CONTEXT_SHARE = 0.02;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const DESCRIPTION_TIERS = [Number.POSITIVE_INFINITY, 160, 80] as const;

export interface AdvertisedSkillCatalogEntry {
  id: string;
  name: string;
  revision: string;
  loadPath: string;
  description: string;
  deferredChars: number;
  invocation?: "auto" | "manual";
  allowedTools?: string[];
  descriptionTruncated: boolean;
  pathShortened: boolean;
}

export interface OmittedSkillCatalogEntry {
  id: string;
  name: string;
  revision: string;
  reason: "budget";
}

export interface SkillCatalogProjection {
  schemaVersion: 1;
  revision: string;
  budgetChars: number;
  renderedChars: number;
  discoveredCount: number;
  enabledCount: number;
  advertisedCount: number;
  truncatedCount: number;
  omittedCount: number;
  sourceChars: number;
  deferredChars: number;
  retrievalFallbackRequired: boolean;
  advertised: AdvertisedSkillCatalogEntry[];
  omissions: OmittedSkillCatalogEntry[];
  catalogXml: string;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

function truncateDescription(description: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || description.length <= maxChars) {
    return description;
  }
  if (maxChars <= 1) return "…";
  return `${description.slice(0, maxChars - 1).trimEnd()}…`;
}

function getLoadPath(skillPath: string): {
  loadPath: string;
  shortened: boolean;
} {
  return { loadPath: path.normalize(skillPath), shortened: false };
}

function renderEntry(entry: AdvertisedSkillCatalogEntry): string {
  const attrs = [
    `id="${xmlEscape(entry.id)}"`,
    `name="${xmlEscape(entry.name)}"`,
    `revision="${xmlEscape(entry.revision)}"`,
    `path="${xmlEscape(entry.loadPath)}"`,
    `deferred-chars="${entry.deferredChars}"`,
    entry.allowedTools?.length
      ? `allowed-tools="${xmlEscape(entry.allowedTools.join(","))}"`
      : undefined,
    entry.invocation ? `invocation="${entry.invocation}"` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `<skill ${attrs}>\n${xmlEscape(entry.description)}\n</skill>`;
}

function buildAdvertisedEntry(
  skill: SkillEntry,
  cwd: string,
  descriptionLimit: number,
): AdvertisedSkillCatalogEntry {
  const normalizedDescription = normalizeDescription(skill.description);
  const description = truncateDescription(
    normalizedDescription,
    descriptionLimit,
  );
  const pathResult = getLoadPath(skill.skillPath);
  return {
    id: skill.id,
    name: skill.name,
    revision: skill.revision,
    loadPath: pathResult.loadPath,
    description,
    deferredChars: skill.sourceChars,
    ...(skill.invocation ? { invocation: skill.invocation } : {}),
    ...(skill.allowedTools?.length
      ? { allowedTools: [...skill.allowedTools] }
      : {}),
    descriptionTruncated: description !== normalizedDescription,
    pathShortened: pathResult.shortened,
  };
}

function renderCatalog(
  entries: readonly AdvertisedSkillCatalogEntry[],
): string {
  if (entries.length === 0) return "";
  return `<skills>\n${entries.map(renderEntry).join("\n")}\n</skills>`;
}

export function resolveSkillCatalogBudgetChars(
  contextWindowTokens?: number,
  overrideChars?: number,
): number {
  if (overrideChars !== undefined) {
    return Math.max(0, Math.floor(overrideChars));
  }
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return DEFAULT_SKILL_CATALOG_BUDGET_CHARS;
  }
  return Math.min(
    DEFAULT_SKILL_CATALOG_BUDGET_CHARS,
    Math.max(
      MIN_SKILL_CATALOG_BUDGET_CHARS,
      Math.floor(
        contextWindowTokens *
          SKILL_CATALOG_CONTEXT_SHARE *
          ESTIMATED_CHARS_PER_TOKEN,
      ),
    ),
  );
}

export function projectSkillCatalog(
  skills: readonly SkillEntry[],
  cwd: string,
  budgetChars: number,
): SkillCatalogProjection {
  const enabled = skills
    .filter((skill) => skill.enabled)
    .sort((left, right) => left.id.localeCompare(right.id));
  const normalizedBudget = Math.max(0, Math.floor(budgetChars));

  let advertised: AdvertisedSkillCatalogEntry[] = [];
  let catalogXml = "";
  for (const descriptionLimit of DESCRIPTION_TIERS) {
    const candidate = enabled.map((skill) =>
      buildAdvertisedEntry(skill, cwd, descriptionLimit),
    );
    const rendered = renderCatalog(candidate);
    advertised = candidate;
    catalogXml = rendered;
    if (rendered.length <= normalizedBudget) break;
  }

  while (advertised.length > 0 && catalogXml.length > normalizedBudget) {
    advertised = advertised.slice(0, -1);
    catalogXml = renderCatalog(advertised);
  }
  if (catalogXml.length > normalizedBudget) {
    advertised = [];
    catalogXml = "";
  }

  const advertisedIds = new Set(advertised.map((entry) => entry.id));
  const omissions = enabled
    .filter((skill) => !advertisedIds.has(skill.id))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      revision: skill.revision,
      reason: "budget" as const,
    }));
  const sourceChars = enabled.reduce(
    (total, skill) => total + skill.sourceChars,
    0,
  );
  const deferredChars = advertised.reduce(
    (total, entry) => total + entry.deferredChars,
    0,
  );
  const truncatedCount = advertised.filter(
    (entry) => entry.descriptionTruncated || entry.pathShortened,
  ).length;
  const revision = stableHash({
    schemaVersion: 1,
    budgetChars: normalizedBudget,
    advertised: advertised.map((entry) => ({
      id: entry.id,
      revision: entry.revision,
      loadPath: entry.loadPath,
      description: entry.description,
    })),
    omissions,
  });

  return {
    schemaVersion: 1,
    revision,
    budgetChars: normalizedBudget,
    renderedChars: catalogXml.length,
    discoveredCount: skills.length,
    enabledCount: enabled.length,
    advertisedCount: advertised.length,
    truncatedCount,
    omittedCount: omissions.length,
    sourceChars,
    deferredChars,
    retrievalFallbackRequired: omissions.length > 0,
    advertised,
    omissions,
    catalogXml,
  };
}
