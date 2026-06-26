import type {
  MemoryOperation,
  MemoryScope,
  MemoryTier,
} from "../approvals/webview/types.js";

const MEMORY_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$/;

export interface MemoryProposalParams {
  tier: MemoryTier;
  scope: MemoryScope;
  operation: MemoryOperation;
  title: string;
  rationale: string;
  content: string;
  name?: string;
  replaces?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findNormalizedRange(
  haystack: string,
  needle: string,
): [number, number] | undefined {
  const normalizedNeedle = normalizeWhitespace(needle);
  if (!normalizedNeedle) return undefined;

  for (let start = 0; start < haystack.length; start += 1) {
    if (/\s/.test(haystack[start] ?? "")) continue;
    let h = start;
    let n = 0;

    while (h < haystack.length && n < normalizedNeedle.length) {
      const hc = haystack[h];
      const nc = normalizedNeedle[n];
      if (/\s/.test(hc)) {
        while (h < haystack.length && /\s/.test(haystack[h])) h += 1;
        if (normalizedNeedle[n] === " ") n += 1;
        continue;
      }
      if (hc !== nc) break;
      h += 1;
      n += 1;
    }

    if (n === normalizedNeedle.length) return [start, h];
  }
  return undefined;
}

export function validateMemoryProposalName(
  params: Pick<MemoryProposalParams, "tier" | "name">,
): string {
  const name = params.name?.trim();
  if (!name) throw new Error(`${params.tier} proposals require a name`);
  if (!MEMORY_NAME_RE.test(name)) {
    throw new Error(
      `${params.tier} name must be lowercase alphanumeric with single hyphens, no leading/trailing hyphen, and at most 64 characters`,
    );
  }
  return name;
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(3, end).trim().split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || !value) continue;
    frontmatter[key] = value;
  }
  return frontmatter;
}

export function validateMemoryProposalSkill(
  params: Pick<MemoryProposalParams, "tier" | "operation" | "name" | "content">,
): void {
  if (params.tier !== "skill" || params.operation === "remove") return;
  const name = validateMemoryProposalName(params);
  const fm = parseFrontmatter(params.content);
  if (fm.name !== name) {
    throw new Error(
      `Skill frontmatter name must match the skill directory name (${JSON.stringify(name)})`,
    );
  }
  if (!fm.description) {
    throw new Error("Skill frontmatter must include a single-line description");
  }
  if (fm.description.length > 1024) {
    throw new Error("Skill description must be at most 1024 characters");
  }
}

function buildMemoryEntry(params: MemoryProposalParams): string {
  const content = params.content.trim();
  if (params.tier !== "memory" || params.operation === "remove") return content;
  if (/<!--\s*added \d{4}-\d{2}-\d{2}\s*-->/.test(content)) return content;
  return `${content}\n<!-- added ${todayIso()} -->`;
}

function appendEntry(existing: string, entry: string): string {
  const trimmedExisting = existing.trimEnd();
  const trimmedEntry = entry.trim();
  if (!trimmedExisting) return `${trimmedEntry}\n`;
  return `${trimmedExisting}\n\n${trimmedEntry}\n`;
}

export function applyMemoryProposal(
  existing: string,
  params: MemoryProposalParams,
): string {
  if (params.tier === "skill" || params.tier === "command") {
    if (params.operation === "remove") return "";
    return params.content.trimEnd() + "\n";
  }

  const entry = buildMemoryEntry(params);
  if (params.operation === "add") return appendEntry(existing, entry);

  if (!params.replaces) {
    throw new Error(`${params.operation} proposals require replaces`);
  }

  const range = findNormalizedRange(existing, params.replaces);
  if (!range) {
    throw Object.assign(
      new Error("Could not find replaces text in target file"),
      {
        currentContent: existing,
      },
    );
  }

  const [start, end] = range;
  if (params.operation === "remove") {
    return `${existing.slice(0, start)}${existing.slice(end)}`.trimEnd() + "\n";
  }

  return (
    `${existing.slice(0, start)}${entry.trim()}${existing.slice(end)}`.trimEnd() +
    "\n"
  );
}

export function retargetMemoryProposal(
  params: MemoryProposalParams,
  decision: {
    memoryTier?: MemoryTier;
    memoryScope?: MemoryScope;
    memoryName?: string;
  },
  content: string,
): MemoryProposalParams {
  return {
    ...params,
    tier: decision.memoryTier ?? params.tier,
    scope: decision.memoryScope ?? params.scope,
    name: decision.memoryName ?? params.name,
    content,
  };
}

export function isSameMemoryProposalDestination(
  a: Pick<MemoryProposalParams, "tier" | "scope" | "name">,
  b: Pick<MemoryProposalParams, "tier" | "scope" | "name">,
): boolean {
  return (
    a.tier === b.tier &&
    a.scope === b.scope &&
    (a.name ?? "") === (b.name ?? "")
  );
}
