import type {
  AgentInstructions,
  AgentPrincipal,
  ResolveAgentInstructions,
} from "@agentlink/core";

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const INSTRUCTION_FILENAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"];
const MAX_COMMAND_DEPTH = 5;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/;

export type NodeHostArtifactScope = "global" | "project";
export type NodeHostArtifactKind = "instruction" | "rule" | "skill" | "command";

/** A host-approved configuration root. Roots are never discovered implicitly. */
export interface NodeHostArtifactRoot {
  readonly id: string;
  readonly scope: NodeHostArtifactScope;
  readonly rootPath: string;
}

export interface NodeHostArtifact {
  readonly id: string;
  readonly kind: NodeHostArtifactKind;
  readonly scope: NodeHostArtifactScope;
  readonly path: string;
  readonly revision: string;
  readonly name?: string;
  readonly description?: string;
}

export interface NodeHostInstructionArtifact extends NodeHostArtifact {
  readonly kind: "instruction" | "rule";
  readonly content: string;
}

export interface NodeHostArtifactDiagnostic {
  readonly code:
    | "invalid-root"
    | "unsafe-symlink"
    | "invalid-frontmatter"
    | "invalid-skill"
    | "invalid-command";
  readonly path: string;
  readonly message: string;
}

export interface NodeHostArtifactCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly instructions: readonly NodeHostInstructionArtifact[];
  readonly skills: readonly NodeHostArtifact[];
  readonly commands: readonly NodeHostArtifact[];
  readonly diagnostics: readonly NodeHostArtifactDiagnostic[];
}

export interface NodeHostArtifactReadRequest {
  readonly catalogRevision: string;
  readonly id: string;
  readonly revision: string;
}

export type NodeHostArtifactReadResult =
  | {
      readonly ok: true;
      readonly artifact: NodeHostArtifact;
      readonly content: string;
    }
  | {
      readonly ok: false;
      readonly reason: "stale_advertised_artifact" | "artifact_not_advertised";
    };

export interface NodeHostArtifactCatalog {
  snapshot(): Promise<NodeHostArtifactCatalogSnapshot>;
  read(
    request: NodeHostArtifactReadRequest,
  ): Promise<NodeHostArtifactReadResult>;
}

export interface CreateNodeHostArtifactCatalogOptions {
  /** Ordered low-to-high precedence roots explicitly resolved by the embedding host. */
  readonly roots: readonly NodeHostArtifactRoot[];
}

/**
 * Loads only conventional artifacts below explicit host-approved roots. This is
 * intentionally a catalog, not a general-purpose filesystem reader or command
 * executor. The host decides which global/project roots are appropriate.
 */
export function createNodeHostArtifactCatalog(
  options: CreateNodeHostArtifactCatalogOptions,
): NodeHostArtifactCatalog {
  const roots = options.roots.map((root, index) => ({ ...root, index }));
  const duplicateIds = new Set<string>();
  for (const root of roots) {
    if (!path.isAbsolute(root.rootPath)) {
      throw new Error(`Node-host artifact root '${root.id}' must be absolute`);
    }
    if (
      !root.id ||
      roots.some((candidate) => candidate !== root && candidate.id === root.id)
    ) {
      duplicateIds.add(root.id);
    }
  }
  if (duplicateIds.size) {
    throw new Error(
      `Node-host artifact root ids must be unique: ${[...duplicateIds].join(", ")}`,
    );
  }

  return {
    snapshot: () => buildSnapshot(roots),
    async read(request) {
      const snapshot = await buildSnapshot(roots);
      if (snapshot.revision !== request.catalogRevision) {
        return { ok: false, reason: "stale_advertised_artifact" };
      }
      const artifact = [
        ...snapshot.instructions,
        ...snapshot.skills,
        ...snapshot.commands,
      ].find(
        (candidate) =>
          candidate.id === request.id &&
          candidate.revision === request.revision,
      );
      if (!artifact) return { ok: false, reason: "artifact_not_advertised" };
      const content = await fs.readFile(artifact.path, "utf8");
      if (digest(content) !== artifact.revision) {
        return { ok: false, reason: "stale_advertised_artifact" };
      }
      return { ok: true, artifact, content };
    },
  };
}

export interface CreateNodeHostInstructionResolverOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Build an explicit catalog for the authenticated principal/session/turn. */
  readonly resolveCatalog: (
    request: Parameters<ResolveAgentInstructions<TPrincipal>>[0],
  ) => NodeHostArtifactCatalog | Promise<NodeHostArtifactCatalog>;
  readonly identity?: string;
}

/** Resolve only inline instructions; deferred skills and commands remain catalog artifacts. */
export function createNodeHostInstructionResolver<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostInstructionResolverOptions<TPrincipal>,
): ResolveAgentInstructions<TPrincipal> {
  return async (request): Promise<AgentInstructions> => {
    const catalog = await options.resolveCatalog(request);
    const snapshot = await catalog.snapshot();
    return {
      ...(options.identity ? { identity: options.identity } : {}),
      instructions: snapshot.instructions
        .map((artifact) => artifact.content)
        .join("\n\n"),
    };
  };
}

async function buildSnapshot(
  roots: readonly (NodeHostArtifactRoot & { index: number })[],
): Promise<NodeHostArtifactCatalogSnapshot> {
  const instructions: NodeHostInstructionArtifact[] = [];
  const skills: NodeHostArtifact[] = [];
  const commandsByName = new Map<string, NodeHostArtifact>();
  const diagnostics: NodeHostArtifactDiagnostic[] = [];

  for (const root of roots) {
    const canonicalRoot = await resolveCanonicalRoot(root, diagnostics);
    if (!canonicalRoot) continue;
    const rootPrefix = `${root.index}:${root.id}`;
    const instruction = await findInstruction(
      root,
      canonicalRoot,
      rootPrefix,
      diagnostics,
    );
    if (instruction) instructions.push(instruction);
    instructions.push(
      ...(await loadRules(root, canonicalRoot, rootPrefix, diagnostics)),
    );
    skills.push(
      ...(await loadSkills(root, canonicalRoot, rootPrefix, diagnostics)),
    );
    for (const command of await loadCommands(
      root,
      canonicalRoot,
      rootPrefix,
      diagnostics,
    )) {
      commandsByName.set(command.name!, command);
    }
  }

  const commands = [...commandsByName.values()].sort((left, right) =>
    left.name!.localeCompare(right.name!),
  );
  const revision = digest(
    JSON.stringify({
      instructions: instructions.map(({ content, ...artifact }) => ({
        ...artifact,
        content,
      })),
      skills,
      commands,
      diagnostics,
    }),
  );
  return {
    schemaVersion: 1,
    revision,
    instructions,
    skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
    commands,
    diagnostics: diagnostics.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

async function resolveCanonicalRoot(
  root: NodeHostArtifactRoot,
  diagnostics: NodeHostArtifactDiagnostic[],
): Promise<string | undefined> {
  try {
    return await fs.realpath(root.rootPath);
  } catch {
    diagnostics.push({
      code: "invalid-root",
      path: root.rootPath,
      message: "Configured artifact root is unavailable",
    });
    return undefined;
  }
}

async function findInstruction(
  root: NodeHostArtifactRoot,
  canonicalRoot: string,
  prefix: string,
  diagnostics: NodeHostArtifactDiagnostic[],
): Promise<NodeHostInstructionArtifact | undefined> {
  for (const filename of INSTRUCTION_FILENAMES) {
    const artifact = await loadArtifact({
      root,
      canonicalRoot,
      candidate: path.join(root.rootPath, filename),
      id: `${prefix}:instruction:${filename}`,
      kind: "instruction",
      diagnostics,
    });
    if (artifact)
      return {
        ...artifact,
        kind: "instruction",
        content: stripFrontmatter(artifact.content),
      };
  }
  return undefined;
}

async function loadRules(
  root: NodeHostArtifactRoot,
  canonicalRoot: string,
  prefix: string,
  diagnostics: NodeHostArtifactDiagnostic[],
): Promise<NodeHostInstructionArtifact[]> {
  const directory = path.join(root.rootPath, "rules");
  const entries = await safeDirectory(directory);
  const rules: NodeHostInstructionArtifact[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const artifact = await loadArtifact({
      root,
      canonicalRoot,
      candidate: path.join(directory, entry.name),
      id: `${prefix}:rule:${entry.name}`,
      kind: "rule",
      diagnostics,
    });
    if (artifact)
      rules.push({
        ...artifact,
        kind: "rule",
        content: stripFrontmatter(artifact.content),
      });
  }
  return rules;
}

async function loadSkills(
  root: NodeHostArtifactRoot,
  canonicalRoot: string,
  prefix: string,
  diagnostics: NodeHostArtifactDiagnostic[],
): Promise<NodeHostArtifact[]> {
  const directory = path.join(root.rootPath, "skills");
  const entries = await safeDirectory(directory);
  const skills: NodeHostArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const artifact = await loadArtifact({
      root,
      canonicalRoot,
      candidate: path.join(directory, name, "SKILL.md"),
      id: `${prefix}:skill:${name}`,
      kind: "skill",
      diagnostics,
    });
    if (!artifact) continue;
    const metadata = parseFrontmatter(artifact.content);
    if (!metadata.ok) {
      diagnostics.push({
        code: "invalid-frontmatter",
        path: artifact.path,
        message: metadata.message,
      });
      continue;
    }
    if (
      metadata.values.name !== name ||
      !SKILL_NAME_PATTERN.test(name) ||
      !metadata.values.description
    ) {
      diagnostics.push({
        code: "invalid-skill",
        path: artifact.path,
        message:
          "SKILL.md requires a matching lowercase name and a description",
      });
      continue;
    }
    skills.push({
      ...toPublicArtifact(artifact),
      name,
      description: metadata.values.description,
    });
  }
  return skills;
}

async function loadCommands(
  root: NodeHostArtifactRoot,
  canonicalRoot: string,
  prefix: string,
  diagnostics: NodeHostArtifactDiagnostic[],
  directory = path.join(root.rootPath, "commands"),
  relativeDirectory = "",
  depth = 0,
): Promise<NodeHostArtifact[]> {
  if (depth > MAX_COMMAND_DEPTH) return [];
  const commands: NodeHostArtifact[] = [];
  for (const entry of await safeDirectory(directory)) {
    const relative = relativeDirectory
      ? `${relativeDirectory}:${entry.name}`
      : entry.name;
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      commands.push(
        ...(await loadCommands(
          root,
          canonicalRoot,
          prefix,
          diagnostics,
          path.join(directory, entry.name),
          relative,
          depth + 1,
        )),
      );
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const name = relative.slice(0, -3);
    if (!COMMAND_NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: "invalid-command",
        path: path.join(directory, entry.name),
        message: "Command name is not slash-safe",
      });
      continue;
    }
    const artifact = await loadArtifact({
      root,
      canonicalRoot,
      candidate: path.join(directory, entry.name),
      id: `${prefix}:command:${name}`,
      kind: "command",
      diagnostics,
    });
    if (!artifact) continue;
    const metadata = parseFrontmatter(artifact.content);
    if (!metadata.ok) {
      diagnostics.push({
        code: "invalid-frontmatter",
        path: artifact.path,
        message: metadata.message,
      });
      continue;
    }
    commands.push({
      ...toPublicArtifact(artifact),
      name,
      ...(metadata.values.description
        ? { description: metadata.values.description }
        : {}),
    });
  }
  return commands;
}

async function loadArtifact(params: {
  root: NodeHostArtifactRoot;
  canonicalRoot: string;
  candidate: string;
  id: string;
  kind: NodeHostArtifactKind;
  diagnostics: NodeHostArtifactDiagnostic[];
}): Promise<(NodeHostArtifact & { content: string }) | undefined> {
  let realPath: string;
  try {
    realPath = await fs.realpath(params.candidate);
  } catch {
    return undefined;
  }
  if (!isWithin(params.canonicalRoot, realPath)) {
    params.diagnostics.push({
      code: "unsafe-symlink",
      path: params.candidate,
      message: "Artifact symlink escapes its configured root",
    });
    return undefined;
  }
  const stat = await fs.stat(realPath).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const content = await fs.readFile(realPath, "utf8");
  return {
    id: params.id,
    kind: params.kind,
    scope: params.root.scope,
    path: realPath,
    revision: digest(content),
    content,
  };
}

function toPublicArtifact({
  content: _content,
  ...artifact
}: NodeHostArtifact & { content: string }): NodeHostArtifact {
  return artifact;
}

function parseFrontmatter(
  content: string,
):
  | { ok: true; values: Record<string, string> }
  | { ok: false; message: string } {
  if (!content.startsWith("---\n")) return { ok: true, values: {} };
  const end = content.indexOf("\n---", 4);
  if (
    end === -1 ||
    (content[end + 4] !== "\n" && content[end + 4] !== undefined)
  ) {
    return {
      ok: false,
      message: "Frontmatter must have a closing delimiter on its own line",
    };
  }
  const values: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0)
      return {
        ok: false,
        message: "Frontmatter entries must be key-value pairs",
      };
    const key = line.slice(0, separator).trim();
    if (Object.hasOwn(values, key))
      return { ok: false, message: `Frontmatter field '${key}' is duplicated` };
    values[key] = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  }
  return { ok: true, values };
}

function stripFrontmatter(content: string): string {
  const parsed = parseFrontmatter(content);
  if (!parsed.ok || !content.startsWith("---\n")) return content.trim();
  return content.slice(content.indexOf("\n---", 4) + 4).trim();
}

async function safeDirectory(
  directory: string,
): Promise<import("node:fs").Dirent[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
  } catch {
    return [];
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
