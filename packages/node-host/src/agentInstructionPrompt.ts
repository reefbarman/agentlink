/**
 * Prompt sections for discovered instructions, deferred rules and skills.
 * Moved verbatim from VS Code's `src/agent/systemPrompt.ts`, which imports
 * them from here, so every surface renders the same text.
 */
import * as path from "node:path";

import type { InstructionBlock } from "./instructionDiscovery.js";
import type { SkillCatalogProjection } from "./skillCatalogProjection.js";
import picomatch from "picomatch";

export interface AdvertisedRuleEntry {
  source: string;
  filePath: string;
  loadPath: string;
  summary?: string;
  globs?: string[];
}

export interface InstructionSections {
  inlineInstructions: string;
  ruleCatalogSection: string;
  ruleCount: number;
  advertisedRules: AdvertisedRuleEntry[];
}

export interface InstructionPartitionOptions {
  activeFilePath?: string;
}

export function formatInstructionBlock(block: InstructionBlock): string {
  return `# Instructions (${block.source}):\n${block.content}`;
}

export function formatRuleCatalogPath(
  block: InstructionBlock,
  cwd: string,
): string {
  if (!block.filePath) return block.source;

  const relativePath = path.relative(cwd, block.filePath);
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return block.filePath;
}

function normalizePathForGlob(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function ruleMatchesActiveFile(
  block: InstructionBlock,
  cwd: string,
  activeFilePath?: string,
): boolean {
  if (!activeFilePath || !block.globs?.length) return false;

  const activeAbsolutePath = path.resolve(activeFilePath);
  const relativePath = path.relative(
    block.projectRoot ?? cwd,
    activeAbsolutePath,
  );
  const candidates = [normalizePathForGlob(activeAbsolutePath)];
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    candidates.push(normalizePathForGlob(relativePath));
  }

  return block.globs.some((glob) =>
    candidates.some((candidate) =>
      picomatch.isMatch(candidate, glob, { dot: true }),
    ),
  );
}

export function isDeferredRuleBlock(block: InstructionBlock): boolean {
  return block.kind === "rule" && !block.alwaysApply;
}

export function shouldInlineInstructionBlock(
  block: InstructionBlock,
  cwd: string,
  options?: InstructionPartitionOptions,
): boolean {
  return (
    !isDeferredRuleBlock(block) ||
    ruleMatchesActiveFile(block, cwd, options?.activeFilePath)
  );
}

export function buildInstructionSections(
  blocks: InstructionBlock[],
  cwd: string,
  options?: InstructionPartitionOptions,
): InstructionSections {
  const inlineBlocks = blocks.filter((block) =>
    shouldInlineInstructionBlock(block, cwd, options),
  );
  const ruleBlocks = blocks.filter(
    (block) => !shouldInlineInstructionBlock(block, cwd, options),
  );

  const inlineInstructions = inlineBlocks
    .map(formatInstructionBlock)
    .join("\n\n");
  const advertisedRules = ruleBlocks
    .filter((block): block is InstructionBlock & { filePath: string } =>
      Boolean(block.filePath),
    )
    .map((block) => {
      const summary = getRuleCatalogSummary(block.content, block.description);
      return {
        source: block.source,
        filePath: block.filePath,
        loadPath: formatRuleCatalogPath(block, block.projectRoot ?? cwd),
        ...(summary ? { summary } : {}),
        ...(block.globs?.length ? { globs: block.globs } : {}),
      };
    });
  const ruleCatalogSection = buildRuleCatalogSection(
    advertisedRules,
    ruleBlocks,
  );

  return {
    inlineInstructions,
    ruleCatalogSection,
    ruleCount: ruleBlocks.length,
    advertisedRules,
  };
}

export function getRuleCatalogSummary(
  content: string,
  description?: string,
): string {
  const frontmatterDescription = description?.trim();
  if (frontmatterDescription) return frontmatterDescription.slice(0, 160);

  const firstSignalLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("<!--"));

  if (!firstSignalLine) return "";

  return firstSignalLine.replace(/^#+\s*/, "").slice(0, 160);
}

function buildRuleCatalogSection(
  advertisedRules: AdvertisedRuleEntry[],
  blocks: InstructionBlock[],
): string {
  if (blocks.length === 0) return "";

  const advertisedBySource = new Map(
    advertisedRules.map((rule) => [rule.source, rule]),
  );
  const lines = blocks.map((block) => {
    const advertised = advertisedBySource.get(block.source);
    const loadPath = advertised?.loadPath ?? block.filePath ?? block.source;
    const contentChars = block.content.length;
    const summary =
      advertised?.summary ??
      getRuleCatalogSummary(block.content, block.description);
    const summaryText = summary ? ` — ${summary}` : "";
    const globs = advertised?.globs ?? block.globs;
    const globText = globs?.length ? ` Applies to: ${globs.join(", ")}.` : "";
    return `- ${block.source}${summaryText} (${contentChars} chars deferred).${globText} Load when relevant with \`load_rule\` path: \`${loadPath}\`.`;
  });

  return `\n\n## Rule Catalog\n\nThe following local rule files are available but their full contents are deferred to reduce prompt bloat. When a task may be governed by one of these rules, including when a listed glob matches files you will inspect or edit, load the relevant file with \`load_rule\` before acting.\n\n${lines.join("\n")}`;
}

/** The "Custom Instructions" section wrapping inline instruction blocks. */
export function renderCustomInstructionsSection(
  inlineInstructions: string,
): string {
  return inlineInstructions
    ? `\n\n## Custom Instructions\n\nThe following instructions are provided by the project and should be followed.\n\n${inlineInstructions}`
    : "";
}

/**
 * Build the skills XML section injected into the system prompt.
 * The model uses this to decide whether to self-activate a skill by calling load_skill.
 */
export function renderSkillsSection(catalog: SkillCatalogProjection): string {
  if (catalog.enabledCount === 0) return "";

  const omissionNotice = catalog.omittedCount
    ? `\n\n${catalog.omittedCount} additional enabled skill${catalog.omittedCount === 1 ? " was" : "s were"} omitted from this prompt because the ${catalog.budgetChars}-character metadata budget was reached. Their canonical identities and revisions remain available to the session catalog.`
    : "";

  return `

## Skills

You have access to the following skills. Before each response, check if any skill matches the user's request. If one matches, follow its instructions: user-selected skills arrive already activated in host \`<skill_context>\` blocks, so do not reload them; otherwise call \`load_skill\` with the skill's \`path\`. If a skill has \`invocation="manual"\`, load it only when the user explicitly asks for that skill or workflow. If a loaded skill declares \`allowed-tools\`, those tools become the active tool restriction for subsequent turns while you are following that skill. \`load_skill\` only activates \`SKILL.md\` files; read a skill's supporting files only when needed, resolving relative references against its \`skillDirectory\`: use \`read_skill_resource\` for built-in skills and \`read_file\` for others. If no skill matches, respond normally — skills are optional enhancements, not required steps.

${catalog.catalogXml}${omissionNotice}`;
}
