import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import {
  buildInstructionSections,
  renderCustomInstructionsSection,
  renderSkillsSection,
  type AdvertisedRuleEntry,
} from "@agentlink/node-host";
import {
  buildBackgroundAgentSection,
  buildBasePrompt,
  buildModePrompt,
  buildWorkspaceFoldersSection,
  COMPOSE_ROUTING_SECTION,
  formatModeInstructionBlock,
  getProviderPrompt,
  LIGHTWEIGHT_REVIEW_BACKGROUND_SECTION,
  MODES_OVERVIEW_SECTION,
  REASONING_INLINE_MODES_SECTION,
  SESSION_HISTORY_RECALL_GUIDANCE,
} from "@agentlink/core/system-prompt";
import type {
  ContextBreakdownItem,
  RequestContextBreakdown,
} from "@agentlink/protocol/context-diagnostics";
import {
  promptProfileResolutionsEqual,
  type PromptProfile,
  type PromptProfileResolution,
} from "@agentlink/protocol/prompt-profile";
import { resolvePromptProfile } from "../core/promptProfilePolicy.js";
import { measureContextItem } from "./contextBreakdown.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import {
  loadAllInstructionBlocks,
  loadAllInstructions,
  loadModeRules,
  resolveProjectActiveFilePath,
  type InstructionBlock,
  type ProjectActiveFileResolution,
} from "./configLoader.js";
import {
  loadCanonicalSkillCatalogForModes,
  loadSkillCatalog,
  type SkillEntry,
  type SkillDiagnostic,
} from "./skillLoader.js";
import type { AgentPluginCatalogProvider } from "./AgentPluginCatalog.js";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import {
  projectSkillCatalog,
  resolveSkillCatalogBudgetChars,
  type SkillCatalogProjection,
} from "./skillCatalogProjection.js";
import { providerRegistry } from "./providers/index.js";
import { BUILT_IN_MODES, type AgentMode } from "./modes.js";
import {
  buildMcpToolCatalogSection,
  type McpToolDisclosureCatalogEntry,
} from "./mcpToolDisclosure.js";

export interface PromptArtifacts {
  systemPrompt: string;
  promptProfile: Readonly<PromptProfileResolution>;
  skills: SkillEntry[];
  /** Discovery evidence only, never activation authority or prompt instructions. */
  skillDiagnostics?: SkillDiagnostic[];
  advertisedRules: AdvertisedRuleEntry[];
  skillCatalog?: SkillCatalogProjection;
  activeFileContext?: ProjectActiveFileResolution;
  promptBreakdown: RequestContextBreakdown["prompt"];
}

/** A workspace folder the agent should know about (multi-root workspaces). */
export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

// Instruction, rule-catalog and skill prompt sections are shared with every
// agent surface; see `agentInstructionPrompt.ts` in `@agentlink/node-host`.
export {
  formatRuleCatalogPath,
  getRuleCatalogSummary,
  isDeferredRuleBlock,
  shouldInlineInstructionBlock,
  type AdvertisedRuleEntry,
  type InstructionPartitionOptions,
} from "@agentlink/node-host";

// Guidance sections are shared with every agent surface; see
// `systemPromptSections.ts` in `@agentlink/core`.
export { SESSION_HISTORY_RECALL_GUIDANCE };

const INDEXED_TOOL_SCOPE_GUIDANCE = `## Indexed tool scope

- \`search_files\` requires exactly one of two exclusive inputs: use \`query\` for ranked workspace search when the location or wording is not known, and \`regex\` for exact text or patterns. Both or neither input is invalid. Give query searches an explicit file or directory path; query search is workspace-only, including single-file scopes. If the user names a known file, use \`read_file\` with \`view: "context"\` first rather than searching for it.
- Query results report the ranking actually used: hybrid, lexical, or keyword fallback, with a bounded reason when ranking degraded. \`embeddings_disabled\` means intentional lexical operation, not a failure. Use \`exclude_globs\` to omit noisy paths from a query.
- For external paths, use regex \`search_files\`, \`read_file\`, and \`list_files\`, subject to existing path permissions and approvals. \`read_file\` has anchors and line offsets, not search queries; \`list_files\` lists paths and does not perform ranked search. Never redirect an external query to the current workspace.
- Browser workspace chat mirrors this search contract. Projectless Browser Ask Agent has no workspace index and remains regex-only.`;

const COMPATIBILITY_IDENTITY =
  "You are AgentLink, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices. You operate inside a VS Code extension and have access to the user's workspace.";
const REASONING_IDENTITY =
  "You are AgentLink, a software engineering agent operating in a VS Code workspace.";
const LIGHTWEIGHT_IDENTITY =
  "You are AgentLink, a skilled software engineer running as a background review agent inside a VS Code extension.";

/**
 * Run a git command asynchronously, returning trimmed stdout or null on failure.
 */
function git(cwd: string, args: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      `git ${args}`,
      { cwd, encoding: "utf-8", timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

/**
 * Get the system info section with OS/shell/git details.
 */
async function getSystemInfo(
  cwd: string,
  model?: string,
  workspaceFolders?: WorkspaceFolderInfo[],
): Promise<string> {
  const platform = os.platform();
  const shell = process.env.SHELL || process.env.COMSPEC || "unknown";
  const arch = os.arch();

  let gitSection = "";
  const branch = await git(cwd, "rev-parse --abbrev-ref HEAD");
  if (branch) {
    const status = (await git(cwd, "status --short")) || "";
    const changedFiles = status.split("\n").filter((l) => l.length > 0);
    const statusSummary =
      changedFiles.length === 0
        ? "clean"
        : `${changedFiles.length} changed file${changedFiles.length !== 1 ? "s" : ""}`;
    gitSection = `\n- Git branch: ${branch}\n- Git status: ${statusSummary}`;
  }

  const modelLine = model ? `\n- Model: ${model}` : "";

  const foldersSection = buildWorkspaceFoldersSection(workspaceFolders);

  return `
## System Information

- OS: ${platform} (${arch})
- Shell: ${shell}
- Home: ${os.homedir()}${modelLine}${gitSection}${foldersSection}`;
}

async function loadWorkspaceInstructionBlocks(
  cwd: string,
  workspaceFolders: WorkspaceFolderInfo[] | undefined,
  activeFilePath: string | undefined,
): Promise<InstructionBlock[]> {
  if (!workspaceFolders || workspaceFolders.length <= 1) {
    return loadAllInstructionBlocks(cwd, { activeFilePath });
  }

  const roots = workspaceFolders.map((folder) => path.resolve(folder.path));
  const loaded = await Promise.all(
    workspaceFolders.map(async (folder) => {
      const root = path.resolve(folder.path);
      const folderActiveFile =
        activeFilePath &&
        (activeFilePath === root ||
          activeFilePath.startsWith(`${root}${path.sep}`))
          ? activeFilePath
          : undefined;
      return {
        folder,
        blocks: await loadAllInstructionBlocks(root, {
          activeFilePath: folderActiveFile,
        }),
      };
    }),
  );

  const seenGlobalSources = new Set<string>();
  return loaded.flatMap(({ folder, blocks }) =>
    blocks.flatMap((block) => {
      const isGlobal =
        block.source.startsWith("~/") ||
        Boolean(
          block.filePath &&
          !roots.some(
            (root) =>
              block.filePath === root ||
              block.filePath!.startsWith(`${root}${path.sep}`),
          ),
        );
      if (isGlobal) {
        if (seenGlobalSources.has(block.source)) return [];
        seenGlobalSources.add(block.source);
        return [block];
      }
      return [
        {
          ...block,
          source: `${folder.name}/${block.source}`,
          projectRoot: path.resolve(folder.path),
        },
      ];
    }),
  );
}

/**
 * Dev mode feedback prompt: an evidence-grounded self-improvement loop.
 */
function getDevFeedbackPrompt(): string {
  return `
## Tool Feedback (Dev Mode)

You have access to \`send_feedback\`, \`get_feedback\`, and \`triage_feedback\` tools. Help AgentLink improve itself as you work:

- **Notice opportunities for self-improvement:** report concrete AgentLink bugs and suggest fixes, workflow improvements, or new capabilities grounded in actual task experience. Successful tasks can reveal unnecessary steps, confusing workflows, or missing capabilities too. Use the affected native tool name, or \`tool_name: "agentlink"\` for a cross-tool or general AgentLink workflow.
- **Preserve valuable bug reports:** include relevant inputs, results, reproduction details, observed impact, recovery, and recurrence. A bug report never needs a diagnosis or proposed fix. Use optional \`category\` (\`bug\`, \`improvement\`, or \`feature_request\`), \`suspected_cause\` for an uncertain diagnosis, \`suggested_change\` for a proposed fix or feature, and \`improvement_signal\` for an observable success check. Keep facts, hypotheses, and proposals separate; omit causes you do not know.
- **Suggest what would make the next task better:** when you have a useful idea, describe the capability and how it addresses the observed need without investigating AgentLink's implementation. Do not invent savings, severity, or prevalence. Report naturally without a feedback quota, generic wishlists, routine praise, or derailing the user's task. Proposals do not authorize self-modification or weakening approvals and safety boundaries.
- For MCP-related work, only submit feedback about AgentLink's native MCP tools (such as \`find_mcp_tools\` and \`call_mcp_tool\`) or AgentLink-owned discovery, transport, approval, dispatch, or result handling. Never submit feedback about a specific MCP server or its native \`server__tool\`: bugs, limitations, confusing output, and domain errors in that server are upstream and out of scope. If AgentLink's MCP plumbing is the problem, use the native AgentLink MCP tool actually involved and include server/tool details only when needed as reproduction context.
- Include the parameters you passed and a summary of what happened when relevant, so bugs remain diagnosable. Even minor friction and grounded feature opportunities are valuable; do not wait to be asked.
- Use \`get_feedback\` to read previously submitted feedback when relevant (e.g. before working on tool improvements).
- After evaluating untriaged feedback, use \`triage_feedback\` only for items judged worth fixing or improving and assign each one a P0-P3 priority. Triaged means accepted for fixing or improvement, not merely reviewed. Evaluate bug evidence independently of suggested solutions, and evaluate feature requests against the observed need and product fit without requiring a failing test. Before asking the user to approve improvement or feature proposals, give your own critical assessment: practical value versus implementation and maintenance complexity, whether the idea is mostly a gimmick or duplicates existing capabilities, simpler alternatives (including no change), and a clear recommendation with evidence and uncertainty. Present grounded proposals you recommend declining too, not only endorsements. The AI's assessment must inform the user's approval; do not merely ask for their thoughts. Backlog approval is not implementation permission. Do not discard useful improvements merely because they are P2/P3; hide deliberately declined feedback instead of triaging it.`;
}

/**
 * Load project custom instructions from the workspace root.
 * Delegates to configLoader for multi-source loading.
 * @deprecated Use loadAllInstructions from configLoader directly.
 */
export async function loadCustomInstructions(
  cwd: string,
  opts?: { activeFilePath?: string },
): Promise<string> {
  return loadAllInstructions(cwd, opts);
}

function buildPromptBreakdown(sections: ContextBreakdownItem[]): {
  sections: ContextBreakdownItem[];
  totalChars: number;
  estimatedTokens: number;
} {
  const nonEmptySections = sections.filter((section) => section.chars > 0);
  const totalChars = nonEmptySections.reduce(
    (sum, section) => sum + section.chars,
    0,
  );
  return {
    sections: nonEmptySections,
    totalChars,
    estimatedTokens: estimateTokensFromChars(totalChars),
  };
}

const BUILT_IN_MODE_SLUGS = BUILT_IN_MODES.map((m) => m.slug);

/**
 * Build the mode instruction block injected into the conversation when the
 * system prompt uses conversation placement for mode content. Carries
 * everything mode-specific that would otherwise live in the system prompt.
 */
export async function buildModeInstructionBlock(
  mode: string,
  cwd: string,
  options?: {
    agentMode?: AgentMode;
    approveForMe?: boolean;
    initialArchitectReviewPending?: boolean;
    promptProfile?: PromptProfile;
  },
): Promise<string> {
  const modeRules = await loadModeRules(cwd, mode);
  return formatModeInstructionBlock(mode, {
    ...options,
    modeRules,
    plansFolderExists:
      mode === "architect" && fs.existsSync(path.join(cwd, "plans")),
  });
}

/**
 * OpenCode-style environment block for providers that detect the client
 * working directory from the system prompt. Meridian reads only the first
 * `Working directory:` line, so multi-root workspaces declare the primary root.
 */
function getWorkingDirectoryEnvBlock(cwd: string, model?: string): string {
  if (!model) return "";
  const provider = providerRegistry.tryResolveProvider(model);
  if (!provider?.declaresWorkingDirectoryInPrompt?.()) return "";
  return `\n\n<env>\nWorking directory: ${cwd}\n</env>`;
}

/**
 * Build a minimal system prompt for background review agents.
 * Strips communication style, rich output, ask_user guidance, provider tuning,
 * custom instructions, skills, and dev feedback — only keeps identity, mode
 * prompt, and the background review section.
 */
function buildLightweightPromptArtifacts(
  mode: string,
  cwd: string,
  promptProfile: Readonly<PromptProfileResolution>,
  workspaceFolders?: WorkspaceFolderInfo[],
  agentMode?: AgentMode,
  workingDirectoryEnvBlock = "",
): Omit<PromptArtifacts, "skills" | "advertisedRules"> {
  const identity = LIGHTWEIGHT_IDENTITY;
  const rootSection = `
- The project root directory is: ${cwd}
- All file paths should be relative to this directory.${buildWorkspaceFoldersSection(workspaceFolders)}${workingDirectoryEnvBlock}`;
  const modePrompt = buildModePrompt(mode, agentMode, promptProfile.profile);
  const backgroundSection = LIGHTWEIGHT_REVIEW_BACKGROUND_SECTION;

  const sections = [
    measureContextItem("lightweight identity", identity),
    measureContextItem("lightweight root/system info", rootSection),
    measureContextItem(`mode:${mode}`, modePrompt),
    measureContextItem("background agent", backgroundSection),
  ];
  const systemPrompt = `${identity}
${rootSection}
${modePrompt}
${backgroundSection}`.trimEnd();
  const promptBreakdown: RequestContextBreakdown["prompt"] =
    buildPromptBreakdown(sections);
  promptBreakdown.profile = promptProfile.profile;
  promptBreakdown.profileSource = promptProfile.source;
  promptBreakdown.profilePolicyRevision = promptProfile.policyRevision;
  return { systemPrompt, promptProfile, promptBreakdown };
}

/**
 * Build the complete system prompt for a given mode.
 * When devMode is true, includes instructions to submit tool feedback.
 * When providerId is set, includes provider-specific behavioral tuning.
 * When lightweight is true, builds a minimal prompt (used for background reviews).
 */
export async function buildPromptArtifacts(
  mode: string,
  cwd: string,
  options?: {
    devMode?: boolean;
    activeFilePath?: string;
    providerId?: string;
    /** Optional vendor behavior for a model behind an OpenAI-compatible transport. */
    modelFamily?: "anthropic" | "openai";
    model?: string;
    isBackground?: boolean;
    lightweight?: boolean;
    workspaceFolders?: WorkspaceFolderInfo[];
    mcpToolCatalog?: McpToolDisclosureCatalogEntry[];
    agentMode?: AgentMode;
    disabledSkillIds?: readonly string[];
    projectScope?: Readonly<SessionProjectScope>;
    agentPluginCatalogProvider?: AgentPluginCatalogProvider;
    promptProfile?: Readonly<PromptProfileResolution>;
    promptProfileOverrides?: Readonly<Record<string, PromptProfile>>;
    /** Deterministic catalog-budget override for evaluation and tests. */
    skillCatalogBudgetChars?: number;
    /** Approve for Me is active: mode switches are allowed automatically. */
    approveForMe?: boolean;
    /** Initial Architect sessions require one explicit human-approved exit. */
    initialArchitectReviewPending?: boolean;
    /** Compose is advertised for this workspace foreground session. */
    composeEnabled?: boolean;
    /**
     * Where mode-specific instructions live. "system" (default) inlines them
     * in the system prompt; "conversation" keeps the system prompt
     * byte-identical across modes — mode content is delivered via
     * `buildModeInstructionBlock` messages so mode switches preserve the
     * provider prompt cache.
     */
    modeInstructionPlacement?: "system" | "conversation";
  },
): Promise<PromptArtifacts> {
  const resolvedPromptProfile = resolvePromptProfile({
    providerId: options?.providerId,
    modelId: options?.model ?? "",
    configuredProfile: options?.model
      ? providerRegistry
          .tryResolveProvider(options.model)
          ?.getPromptProfile?.(options.model)
      : undefined,
    overrides: options?.promptProfileOverrides,
  });
  const promptProfile = promptProfileResolutionsEqual(
    options?.promptProfile,
    resolvedPromptProfile,
  )
    ? options.promptProfile
    : resolvedPromptProfile;
  const workingDirectoryEnvBlock = getWorkingDirectoryEnvBlock(
    cwd,
    options?.model,
  );
  // Lightweight path: minimal prompt for background review agents
  if (options?.lightweight) {
    return {
      ...buildLightweightPromptArtifacts(
        mode,
        cwd,
        promptProfile,
        options.workspaceFolders,
        options.agentMode,
        workingDirectoryEnvBlock,
      ),
      skills: [],
      advertisedRules: [],
    };
  }

  const activeFileContext = await resolveProjectActiveFilePath(
    cwd,
    options?.activeFilePath,
  );
  const activeFilePath =
    activeFileContext?.status === "accepted"
      ? activeFileContext.activeFilePath
      : undefined;
  const base = buildBasePrompt(promptProfile.profile, {
    identity:
      promptProfile.profile === "reasoning"
        ? REASONING_IDENTITY
        : COMPATIBILITY_IDENTITY,
    cwd,
    indexedToolScope: INDEXED_TOOL_SCOPE_GUIDANCE,
  });
  const conversationModePlacement =
    options?.modeInstructionPlacement === "conversation";
  const modePrompt = conversationModePlacement
    ? MODES_OVERVIEW_SECTION
    : `${promptProfile.profile === "reasoning" ? REASONING_INLINE_MODES_SECTION : ""}${buildModePrompt(
        mode,
        options?.agentMode,
        promptProfile.profile,
        options?.approveForMe,
        options?.initialArchitectReviewPending,
      )}`;
  const promptProviderId =
    options?.modelFamily ??
    (options?.model
      ? (providerRegistry
          .tryResolveProvider(options.model)
          ?.getModelFamily?.(options.model) ?? options.providerId)
      : options?.providerId);
  const providerPrompt = getProviderPrompt(
    promptProfile.profile,
    promptProviderId,
  );
  const systemInfo = await getSystemInfo(
    cwd,
    options?.model,
    options?.workspaceFolders,
  );
  const devFeedback = options?.devMode ? getDevFeedbackPrompt() : "";
  const composeRouting =
    options?.composeEnabled && !options.isBackground
      ? COMPOSE_ROUTING_SECTION
      : "";
  // Cross-session history tools are bound only to foreground sessions.
  const sessionHistoryRecall = options?.isBackground
    ? ""
    : `\n\n${SESSION_HISTORY_RECALL_GUIDANCE}`;

  const skillModeSlugs = [
    ...BUILT_IN_MODE_SLUGS,
    ...(BUILT_IN_MODE_SLUGS.includes(mode) ? [] : [mode]),
  ];
  const pluginSkills =
    options?.projectScope && options.agentPluginCatalogProvider
      ? (
          await options.agentPluginCatalogProvider.getSnapshot(
            options.projectScope,
          )
        ).skills
      : [];
  const skillOptions = {
    disabledSkillIds: options?.disabledSkillIds,
    additionalEntries: pluginSkills,
  };
  const [instructionBlocks, modeRules, discoveredSkills] = await Promise.all([
    loadWorkspaceInstructionBlocks(
      cwd,
      options?.workspaceFolders,
      options?.activeFilePath,
    ),
    // With conversation placement, mode rules travel in the mode block so the
    // system prompt stays identical across modes.
    conversationModePlacement ? Promise.resolve("") : loadModeRules(cwd, mode),
    // Likewise the skills TOC must not vary by mode: advertise the union
    // across modes (mode-restricted skills are still labeled by their dirs).
    conversationModePlacement
      ? loadCanonicalSkillCatalogForModes(cwd, skillModeSlugs, skillOptions)
      : loadSkillCatalog(cwd, mode, skillOptions),
  ]);
  const skills = discoveredSkills.entries.filter((entry) => entry.enabled);
  const instructionSections = buildInstructionSections(instructionBlocks, cwd, {
    activeFilePath,
  });

  const customSection = renderCustomInstructionsSection(
    instructionSections.inlineInstructions,
  );

  const rulesSection = modeRules ? `\n\n## Mode Rules\n\n${modeRules}` : "";
  const modelCapabilities = options?.model
    ? providerRegistry
        .tryResolveProvider(options.model)
        ?.getCapabilities(options.model)
    : undefined;
  const skillCatalog = projectSkillCatalog(
    skills,
    cwd,
    resolveSkillCatalogBudgetChars(
      modelCapabilities?.maxInputTokens ?? modelCapabilities?.contextWindow,
      options?.skillCatalogBudgetChars,
    ),
  );
  const skillsSection = renderSkillsSection(skillCatalog);
  const mcpToolCatalogSection = buildMcpToolCatalogSection(
    options?.mcpToolCatalog,
  );

  // With conversation placement these travel in the mode block instead, so
  // architect-specific content cannot leak mode-dependence into the prompt.
  const plansSection =
    mode === "architect" && !conversationModePlacement
      ? `\n- Plans folder (\`./plans\`): ${fs.existsSync(path.join(cwd, "plans")) ? "exists" : "does not exist yet"}`
      : "";

  const approveForMeSection = options?.approveForMe
    ? `\n\n## Mode Switching Under Approve for Me

Approve for Me is enabled for this session: mode switches are normally allowed automatically, so a \`switch_mode\` call does not require Guardian or user approval and does not interrupt the user. This section overrides the mode-switch consent guidance elsewhere in this prompt, except when the current Architect mode instructions say the session's one-time initial plan review is still pending:

- When a mode change is warranted, call \`switch_mode\` directly with a clear \`reason\`. Do not use \`ask_user\` to request permission to switch modes or to proceed unless the current Architect instructions require the one-time initial plan approval.
- Never ask a question whose only purpose is mode-change or plan-approval consent, except for that one-time initial Architect plan approval. Keep using \`ask_user\` whenever you genuinely need the user's input on requirements, trade-offs, or open design decisions; if such a question's answer naturally implies a mode, you may still attach a \`modeSwitch\` map — the user's explicit choice remains valid consent.`
    : "";

  const backgroundSection = options?.isBackground
    ? buildBackgroundAgentSection(mode)
    : "";

  const sections = [
    measureContextItem("base", base),
    measureContextItem(
      conversationModePlacement ? "modes overview" : `mode:${mode}`,
      modePrompt,
    ),
    measureContextItem("approve for me", approveForMeSection),
    measureContextItem(
      options?.providerId ? `provider:${options.providerId}` : "provider",
      providerPrompt,
    ),
    measureContextItem(
      "system info",
      `${systemInfo}${plansSection}${workingDirectoryEnvBlock}`,
    ),
    measureContextItem("dev feedback", devFeedback),
    measureContextItem("compose routing", composeRouting),
    measureContextItem("session history recall", sessionHistoryRecall),
    measureContextItem("custom instructions", customSection),
    measureContextItem(
      "rule catalog (deferred)",
      instructionSections.ruleCatalogSection,
      instructionSections.ruleCount,
    ),
    measureContextItem("mode rules", rulesSection),
    measureContextItem(
      "skills toc",
      skillsSection,
      skillCatalog.advertisedCount,
    ),
    measureContextItem(
      "mcp tool catalog",
      mcpToolCatalogSection,
      options?.mcpToolCatalog?.length ?? 0,
    ),
    measureContextItem("background agent", backgroundSection),
  ];
  const systemPrompt = `${base}
${modePrompt}${approveForMeSection}
${providerPrompt}
${systemInfo}${plansSection}${workingDirectoryEnvBlock}
${devFeedback}${composeRouting}${sessionHistoryRecall}${customSection}${instructionSections.ruleCatalogSection}${rulesSection}${skillsSection}${mcpToolCatalogSection}${backgroundSection}`.trimEnd();

  const promptBreakdown: RequestContextBreakdown["prompt"] =
    buildPromptBreakdown(sections);
  promptBreakdown.profile = promptProfile.profile;
  promptBreakdown.profileSource = promptProfile.source;
  promptBreakdown.profilePolicyRevision = promptProfile.policyRevision;
  promptBreakdown.skillCatalog = {
    revision: skillCatalog.revision,
    budgetChars: skillCatalog.budgetChars,
    renderedChars: skillCatalog.renderedChars,
    sourceChars: skillCatalog.sourceChars,
    deferredChars: skillCatalog.deferredChars,
    discoveredCount: skillCatalog.discoveredCount,
    enabledCount: skillCatalog.enabledCount,
    advertisedCount: skillCatalog.advertisedCount,
    truncatedCount: skillCatalog.truncatedCount,
    omittedCount: skillCatalog.omittedCount,
    retrievalFallbackRequired: skillCatalog.retrievalFallbackRequired,
  };

  return {
    systemPrompt,
    promptProfile,
    skills,
    skillDiagnostics: discoveredSkills.diagnostics,
    skillCatalog,
    advertisedRules: instructionSections.advertisedRules,
    ...(activeFileContext ? { activeFileContext } : {}),
    promptBreakdown,
  };
}

export async function buildSystemPrompt(
  mode: string,
  cwd: string,
  options?: {
    devMode?: boolean;
    activeFilePath?: string;
    providerId?: string;
    /** Optional vendor behavior for a model behind an OpenAI-compatible transport. */
    modelFamily?: "anthropic" | "openai";
    model?: string;
    isBackground?: boolean;
    /** When lightweight is true, builds a minimal prompt (used for background reviews). */
    lightweight?: boolean;
    workspaceFolders?: WorkspaceFolderInfo[];
    mcpToolCatalog?: McpToolDisclosureCatalogEntry[];
    agentMode?: AgentMode;
    disabledSkillIds?: readonly string[];
    projectScope?: Readonly<SessionProjectScope>;
    agentPluginCatalogProvider?: AgentPluginCatalogProvider;
    promptProfile?: Readonly<PromptProfileResolution>;
    promptProfileOverrides?: Readonly<Record<string, PromptProfile>>;
    skillCatalogBudgetChars?: number;
    /** Approve for Me is active: mode switches are allowed automatically. */
    approveForMe?: boolean;
    /** Initial Architect sessions require one explicit human-approved exit. */
    initialArchitectReviewPending?: boolean;
  },
): Promise<string> {
  const artifacts = await buildPromptArtifacts(mode, cwd, options);
  return artifacts.systemPrompt;
}
