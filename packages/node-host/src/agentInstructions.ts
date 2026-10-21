/**
 * Opt-in composition of VS Code's instruction, rule and skill behaviour for
 * any agent built on the SDK: per-turn prompt sections plus the
 * `load_skill`, `read_skill_resource` and `load_rule` tools.
 */
import {
  defineTool,
  type AgentPrincipal,
  type HostTool,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";
import type { ToolResult } from "@agentlink/protocol/tool-result";

import {
  buildInstructionSections,
  renderCustomInstructionsSection,
  renderSkillsSection,
  type AdvertisedRuleEntry,
} from "./agentInstructionPrompt.js";
import {
  loadAllInstructionBlocks,
  loadGlobalInstructionBlocks,
  loadModeRules,
} from "./instructionDiscovery.js";
import {
  projectSkillCatalog,
  resolveSkillCatalogBudgetChars,
  type SkillCatalogProjection,
} from "./skillCatalogProjection.js";
import {
  loadProjectlessSkillCatalog,
  loadSkillCatalog,
  type SkillDiagnostic,
  type SkillEntry,
} from "./skillDiscovery.js";
import {
  createNodeAdvertisedArtifactProvider,
  handleReadSkillResource,
  loadRule,
  loadSkill,
  type AdvertisedArtifactProvider,
  type AllowedSkill,
  type SkillActivation,
} from "./skillTools.js";

/** Tool names, matching VS Code's. */
export const AGENT_INSTRUCTION_TOOL_NAMES = [
  "load_skill",
  "read_skill_resource",
  "load_rule",
] as const;
export type AgentInstructionToolName =
  (typeof AGENT_INSTRUCTION_TOOL_NAMES)[number];

/**
 * Descriptions and input schemas, identical to VS Code's
 * `src/shared/toolRegistry.ts` and `toolSchemas.ts` (a VS Code test keeps
 * them in step).
 */
export const AGENT_INSTRUCTION_TOOL_DEFINITIONS: Readonly<
  Record<
    AgentInstructionToolName,
    {
      readonly description: string;
      readonly input_schema: Record<string, unknown>;
    }
  >
> = {
  load_skill: {
    description:
      "Activate an enabled skill from the current session's revisioned catalog by loading its SKILL.md, including skills omitted from the bounded prompt list. Use the exact canonical path. A rejected path returns up to ten matching catalog candidates without activating them; retry with the intended candidate's path. An exact discovered SKILL.md path excluded from the session catalog may also return bounded diagnostics recorded for that file, without following unadvertised aliases. Correct the reported problem through the normal reviewed workflow and refresh the catalog; diagnostics grant neither activation nor file access. Advertised symlink aliases activate the canonical identity. Only SKILL.md activates; read supporting files with read_skill_resource (built-in skills) or read_file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute or workspace-relative path of a SKILL.md file advertised in the current session's skill catalog.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  read_skill_resource: {
    description:
      "Read a supporting text file from an advertised built-in AgentLink skill without activating it. Use read_file for other skills' files. Page with offset and next_offset.",
    input_schema: {
      type: "object",
      properties: {
        skill_path: {
          type: "string",
          description: "The owning built-in skill's catalog SKILL.md path.",
        },
        resource_path: {
          type: "string",
          description:
            "Path relative to the skill directory, e.g. references/a.md.",
        },
        offset: {
          description: "1-based start line.",
          type: "integer",
          minimum: 1,
          maximum: 9007199254740991,
        },
        limit: {
          description: "Max lines.",
          type: "integer",
          minimum: 1,
          maximum: 2000,
        },
      },
      required: ["skill_path", "resource_path"],
      additionalProperties: false,
    },
  },
  load_rule: {
    description:
      "Load the full contents of a deferred local rule file that was explicitly advertised in the current system prompt Rule Catalog. Only valid for deferred rule paths from the current session's rule catalog; not a general-purpose file reader.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute or workspace-relative path of a deferred rule file that was explicitly advertised in the current system prompt Rule Catalog.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export interface NodeHostAgentInstructionsOptions {
  /**
   * Project root for project instructions, rules and skills (and their
   * ancestors up to the Git root, like VS Code). Omit for a projectless
   * agent, which gets global and built-in sources only.
   */
  readonly projectRoot?: string;
  /**
   * Home folder for global sources (`~/.agents`, `~/.claude`,
   * `~/.agentlink`). Defaults to `os.homedir()`. `null` skips them, for a
   * host whose home folder is not the user's (a server).
   */
  readonly homeDir?: string | null;
  /** Built-in skill folders this host ships. Defaults to none. */
  readonly builtinSkillDirs?: readonly string[];
  /** Mode for `skills-<mode>` and `rules-<mode>` folders. Defaults to `code`. */
  readonly modeSlug?: string;
  /** Skill catalog budget. Defaults to VS Code's (8,000 characters). */
  readonly skillCatalogBudgetChars?: number;
  /**
   * Whether the host enforces a loaded skill's `allowed-tools`. VS Code
   * does; a host that does not gets prompt text that says so instead of
   * claiming the restriction applies. Defaults to false.
   */
  readonly enforcesSkillToolRestrictions?: boolean;
  /** Path resolution and reads for the tools. Defaults to this machine, rooted at the project. */
  readonly artifactProvider?: AdvertisedArtifactProvider;
}

/** What one turn advertised: its prompt text and the files its tools may load. */
export interface NodeHostAgentInstructionsSnapshot {
  /** Custom Instructions, Rule Catalog, Mode Rules and Skills sections. May be empty. */
  readonly prompt: string;
  readonly skills: readonly SkillEntry[];
  readonly skillCatalog: SkillCatalogProjection;
  readonly skillDiagnostics: readonly SkillDiagnostic[];
  readonly advertisedRules: readonly AdvertisedRuleEntry[];
}

export interface NodeHostAgentInstructionToolDefinition {
  readonly name: AgentInstructionToolName;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface NodeHostAgentInstructionToolOutcome {
  readonly result: ToolResult;
  /** Present when `load_skill` activated a skill. */
  readonly activation?: SkillActivation;
}

export interface NodeHostAgentInstructions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Discover afresh, or reuse the snapshot already taken for this session turn. */
  snapshot(turn?: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<NodeHostAgentInstructionsSnapshot>;
  /**
   * `load_rule` is offered only when the snapshot deferred a rule, like VS
   * Code. The skill tools are offered only when it advertised a skill: VS Code
   * always has built-in skills, a host without any should not pay for them.
   */
  toolDefinitions(
    snapshot: NodeHostAgentInstructionsSnapshot,
  ): NodeHostAgentInstructionToolDefinition[];
  executeTool(
    name: AgentInstructionToolName,
    input: Record<string, unknown>,
    snapshot: NodeHostAgentInstructionsSnapshot,
  ): Promise<NodeHostAgentInstructionToolOutcome>;
  /** Prompt sections for a session turn. */
  resolveInstructions(request: {
    readonly session: { readonly sessionId: string };
    readonly turnId: string;
  }): Promise<string>;
  /** The tools as `HostTool`s for `workspace-host` and other core hosts. */
  readonly resolveTools: HostToolResolver<TPrincipal>;
}

const MAX_CACHED_TURNS = 16;

/**
 * Stands in for the project root when there is none. No real file is
 * inside it, so rule catalogs keep absolute paths, as VS Code does for
 * global rules outside its workspace.
 */
const PROJECTLESS_ROOT = "/\u0000agentlink-projectless";

export function isAgentInstructionToolName(
  name: string,
): name is AgentInstructionToolName {
  return (AGENT_INSTRUCTION_TOOL_NAMES as readonly string[]).includes(name);
}

export function createNodeHostAgentInstructions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: NodeHostAgentInstructionsOptions = {},
): NodeHostAgentInstructions<TPrincipal> {
  const modeSlug = options.modeSlug ?? "code";
  const artifactProvider =
    options.artifactProvider ??
    createNodeAdvertisedArtifactProvider(options.projectRoot);
  const discovery = {
    homeDir: options.homeDir,
    builtinSkillDirs: options.builtinSkillDirs,
  };
  const turns = new Map<string, Promise<NodeHostAgentInstructionsSnapshot>>();

  const discover = async (): Promise<NodeHostAgentInstructionsSnapshot> => {
    const root = options.projectRoot;
    const [blocks, modeRules, catalog] = await Promise.all([
      root
        ? loadAllInstructionBlocks(root, { homeDir: options.homeDir })
        : loadGlobalInstructionBlocks({ homeDir: options.homeDir }),
      root ? loadModeRules(root, modeSlug) : Promise.resolve(""),
      root
        ? loadSkillCatalog(root, modeSlug, discovery)
        : loadProjectlessSkillCatalog(modeSlug, discovery),
    ]);
    const sections = buildInstructionSections(blocks, root ?? PROJECTLESS_ROOT);
    const skills = catalog.entries.filter((entry) => entry.enabled);
    const skillCatalog = projectSkillCatalog(
      skills,
      root ?? PROJECTLESS_ROOT,
      resolveSkillCatalogBudgetChars(
        undefined,
        options.skillCatalogBudgetChars,
      ),
    );
    const skillsSection = renderSkillsSection(skillCatalog);
    const prompt = [
      renderCustomInstructionsSection(sections.inlineInstructions),
      sections.ruleCatalogSection,
      modeRules ? `\n\n## Mode Rules\n\n${modeRules}` : "",
      options.enforcesSkillToolRestrictions
        ? skillsSection
        : skillsSection.replace(
            "If a loaded skill declares `allowed-tools`, those tools become the active tool restriction for subsequent turns while you are following that skill.",
            "If a loaded skill declares `allowed-tools`, use only those tools while you are following that skill; this host does not enforce the restriction for you.",
          ),
    ]
      .join("")
      .trim();
    return {
      prompt,
      skills,
      skillCatalog,
      skillDiagnostics: catalog.diagnostics,
      advertisedRules: sections.advertisedRules,
    };
  };

  const snapshot: NodeHostAgentInstructions<TPrincipal>["snapshot"] = (
    turn,
  ) => {
    if (!turn) return discover();
    const key = `${turn.sessionId}\u0000${turn.turnId}`;
    const existing = turns.get(key);
    if (existing) return existing;
    const pending = discover();
    turns.set(key, pending);
    pending.catch(() => turns.delete(key));
    while (turns.size > MAX_CACHED_TURNS) {
      turns.delete(turns.keys().next().value as string);
    }
    return pending;
  };

  const toolDefinitions: NodeHostAgentInstructions<TPrincipal>["toolDefinitions"] =
    (current) =>
      AGENT_INSTRUCTION_TOOL_NAMES.filter((name) =>
        name === "load_rule"
          ? current.advertisedRules.length > 0
          : current.skills.length > 0,
      ).map((name) => ({ name, ...AGENT_INSTRUCTION_TOOL_DEFINITIONS[name] }));

  const executeTool: NodeHostAgentInstructions<TPrincipal>["executeTool"] =
    async (name, input, current) => {
      const allowedSkills = current.skills.map(toAllowedSkill);
      if (name === "load_skill") {
        return await loadSkill(
          { path: String(input.path ?? "") },
          allowedSkills,
          artifactProvider,
          current.skillDiagnostics,
        );
      }
      if (name === "read_skill_resource") {
        return {
          result: await handleReadSkillResource(
            {
              skill_path: String(input.skill_path ?? ""),
              resource_path: String(input.resource_path ?? ""),
              ...(typeof input.offset === "number"
                ? { offset: input.offset }
                : {}),
              ...(typeof input.limit === "number"
                ? { limit: input.limit }
                : {}),
            },
            allowedSkills,
            artifactProvider,
          ),
        };
      }
      return {
        result: await loadRule(
          { path: String(input.path ?? "") },
          [...current.advertisedRules],
          artifactProvider,
        ),
      };
    };

  const resolveTools: HostToolResolver<TPrincipal> = async (request) => {
    const current = await snapshot({
      sessionId: request.sessionId,
      turnId: request.turnId,
    });
    return toolDefinitions(current).map((definition): HostTool<TPrincipal> =>
      defineTool<TPrincipal>({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.input_schema as never,
        effect: "read",
        parallelSafe: true,
        displayInput: (input) =>
          definition.name === "read_skill_resource"
            ? {
                skill_path: input.skill_path,
                resource_path: input.resource_path,
              }
            : { path: input.path },
        handler: async (input) =>
          toHostToolResult(
            (await executeTool(definition.name, input, current)).result,
          ),
      }),
    );
  };

  return {
    snapshot,
    toolDefinitions,
    executeTool,
    async resolveInstructions(request) {
      return (
        await snapshot({
          sessionId: request.session.sessionId,
          turnId: request.turnId,
        })
      ).prompt;
    },
    resolveTools,
  };
}

/** The handlers' view of an advertised skill, as VS Code builds it. */
export function toAllowedSkill(skill: SkillEntry): AllowedSkill {
  return {
    id: skill.id,
    name: skill.name,
    revision: skill.revision,
    skillPath: skill.skillPath,
    realSkillPath: skill.provenance.realSkillPath,
    sourceScope: skill.provenance.scope,
  };
}

function toHostToolResult(result: ToolResult): HostToolResult {
  const text = result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  return {
    modelContent: text,
    ...(result.data !== undefined ? { displayContent: result.data } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}
