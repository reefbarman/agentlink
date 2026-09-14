import {
  defineTool,
  type AgentInstructions,
  type AgentPrincipal,
  type HostTool,
  type HostToolExecutionContext,
  type HostToolResolveRequest,
  type HostToolResolver,
  type ResolveAgentInstructions,
} from "@agentlink/core";
import {
  createNodeHostArtifactCatalog,
  createNodeHostInstructionResolver,
  type NodeHostArtifact,
  type NodeHostArtifactCatalog,
  type NodeHostArtifactDiagnostic,
  type NodeHostArtifactRoot,
} from "@agentlink/node-host";
import path from "node:path";

const ROOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_LISTED_ARTIFACTS = 100;
const MAX_LISTED_DIAGNOSTICS = 50;
const MAX_ARTIFACT_ID_CHARS = 2_048;
const MAX_ARTIFACT_NAME_CHARS = 1_024;
const MAX_DESCRIPTION_BYTES = 1_000;
const MAX_DIAGNOSTIC_BYTES = 1_000;
const MAX_DIAGNOSTIC_PATH_BYTES = 2_000;
const MAX_INLINE_INSTRUCTION_BYTES = 256 * 1024;
const MAX_LOADED_ARTIFACT_BYTES = 256 * 1024;

export type WorkspaceArtifactRoot = NodeHostArtifactRoot;

export interface CreateWorkspaceArtifactToolsOptions {
  /** Ordered low-to-high precedence roots explicitly approved by the host. */
  readonly roots: readonly WorkspaceArtifactRoot[];
  readonly identity?: string;
}

export interface WorkspaceArtifactTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Resolves instruction and rule contents afresh for every turn. */
  readonly resolveInstructions: ResolveAgentInstructions<TPrincipal>;
  /** Advertises bounded artifact metadata and exact skill/command loading tools. */
  readonly resolveTools: HostToolResolver<TPrincipal>;
}

interface ListedArtifact {
  readonly id: string;
  readonly kind: "skill" | "command";
  readonly scope: "global" | "project";
  readonly revision: string;
  readonly name?: string;
  readonly description?: string;
}

interface ListedDiagnostic {
  readonly code: NodeHostArtifactDiagnostic["code"];
  readonly source: string;
  readonly message: string;
}

/**
 * Compose the standalone workspace artifact lane over the public Node-host
 * catalog. The returned tools expose no path parameter or arbitrary read path.
 */
export function createWorkspaceArtifactTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateWorkspaceArtifactToolsOptions,
): WorkspaceArtifactTools<TPrincipal> {
  validateRoots(options.roots);
  const catalog = createNodeHostArtifactCatalog({ roots: options.roots });
  const nodeResolver = createNodeHostInstructionResolver<TPrincipal>({
    identity: options.identity,
    resolveCatalog: () => catalog,
  });

  const resolveInstructions: ResolveAgentInstructions<TPrincipal> = async (
    request,
  ) => {
    const resolved = await nodeResolver(request);
    const normalized: AgentInstructions =
      typeof resolved === "string" ? { instructions: resolved } : resolved;
    if (
      Buffer.byteLength(normalized.identity ?? "", "utf8") +
        Buffer.byteLength(normalized.instructions ?? "", "utf8") >
      MAX_INLINE_INSTRUCTION_BYTES
    ) {
      throw new Error("workspace_artifact_instructions_too_large");
    }
    return normalized;
  };

  const resolveTools: HostToolResolver<TPrincipal> = async (request) => {
    const snapshot = await catalog.snapshot();
    const available = [...snapshot.skills, ...snapshot.commands].filter(
      isListableArtifact,
    );
    const advertised = available.slice(0, MAX_LISTED_ARTIFACTS);
    return [
      createListArtifactsTool(
        request,
        snapshot.revision,
        advertised,
        snapshot.diagnostics,
        options.roots,
        available.length - advertised.length,
      ),
      createLoadArtifactTool(request, catalog, snapshot.revision, advertised),
    ];
  };

  return { resolveInstructions, resolveTools };
}

function createListArtifactsTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  catalogRevision: string,
  artifacts: readonly NodeHostArtifact[],
  diagnostics: readonly NodeHostArtifactDiagnostic[],
  roots: readonly WorkspaceArtifactRoot[],
  omittedArtifacts: number,
): HostTool<TPrincipal> {
  const listedArtifacts = artifacts.map(toListedArtifact);
  const listedDiagnostics = diagnostics
    .slice(0, MAX_LISTED_DIAGNOSTICS)
    .map((diagnostic) => toListedDiagnostic(diagnostic, roots));
  const payload = {
    schemaVersion: 1,
    catalogRevision,
    artifacts: listedArtifacts,
    diagnostics: listedDiagnostics,
    omittedArtifacts,
    omittedDiagnostics: Math.max(
      0,
      diagnostics.length - listedDiagnostics.length,
    ),
  } as const;
  return defineTool({
    name: "list_artifacts",
    description:
      "List bounded metadata for skills and prompt commands advertised from host-approved global and project roots for this turn. Returns the catalog revision required by load_artifact. It does not read arbitrary paths.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "read",
    parallelSafe: true,
    handler: async (_input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      return {
        modelContent: JSON.stringify(payload),
        displayContent: payload,
      };
    },
  });
}

function createLoadArtifactTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  catalog: NodeHostArtifactCatalog,
  catalogRevision: string,
  advertised: readonly NodeHostArtifact[],
): HostTool<TPrincipal> {
  const advertisedById = new Map(
    advertised.map((artifact) => [artifact.id, artifact]),
  );
  return defineTool({
    name: "load_artifact",
    description:
      "Load one exact skill or prompt command advertised by list_artifacts in this same turn. Pass its catalogRevision, id, and revision exactly. This tool cannot read instructions, rules, or arbitrary filesystem paths.",
    inputSchema: {
      type: "object",
      properties: {
        catalogRevision: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        },
        id: { type: "string", minLength: 1, maxLength: MAX_ARTIFACT_ID_CHARS },
        revision: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        },
      },
      required: ["catalogRevision", "id", "revision"],
      additionalProperties: false,
    },
    effect: "read",
    parallelSafe: true,
    displayInput: (input) => ({
      id: input.id,
      revision: input.revision,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const requestedCatalogRevision = stringValue(input.catalogRevision);
      const id = stringValue(input.id);
      const revision = stringValue(input.revision);
      if (requestedCatalogRevision !== catalogRevision) {
        return toolError("stale_advertised_artifact");
      }
      const advertisedArtifact = advertisedById.get(id);
      if (!advertisedArtifact || advertisedArtifact.revision !== revision) {
        return toolError("artifact_not_advertised");
      }
      const result = await catalog
        .read({
          catalogRevision: requestedCatalogRevision,
          id,
          revision,
        })
        .catch(() => ({
          ok: false as const,
          reason: "stale_advertised_artifact" as const,
        }));
      if (!result.ok) return toolError(result.reason);
      if (
        result.artifact.kind !== "skill" &&
        result.artifact.kind !== "command"
      ) {
        return toolError("artifact_not_advertised");
      }
      const bytes = Buffer.byteLength(result.content, "utf8");
      if (bytes > MAX_LOADED_ARTIFACT_BYTES) {
        return toolError("artifact_content_too_large");
      }
      const artifact = toListedArtifact(result.artifact);
      return {
        modelContent: JSON.stringify({ artifact, content: result.content }),
        displayContent: { artifact, bytes },
      };
    },
  });
}

function validateRoots(roots: readonly WorkspaceArtifactRoot[]): void {
  for (const root of roots) {
    if (!path.isAbsolute(root.rootPath)) {
      throw new Error(`Workspace artifact root '${root.id}' must be absolute`);
    }
    if (!ROOT_ID_PATTERN.test(root.id)) {
      throw new Error(
        "Workspace artifact root ids must start with a lowercase letter and contain at most 64 lowercase letters, digits, underscores, or hyphens",
      );
    }
    if (root.scope !== "global" && root.scope !== "project") {
      throw new Error(
        `Workspace artifact root '${root.id}' has an invalid scope`,
      );
    }
  }
}

function isListableArtifact(
  artifact: NodeHostArtifact,
): artifact is NodeHostArtifact & { kind: "skill" | "command" } {
  return (
    (artifact.kind === "skill" || artifact.kind === "command") &&
    artifact.id.length <= MAX_ARTIFACT_ID_CHARS &&
    (artifact.name?.length ?? 0) <= MAX_ARTIFACT_NAME_CHARS
  );
}

function toListedArtifact(artifact: NodeHostArtifact): ListedArtifact {
  if (artifact.kind !== "skill" && artifact.kind !== "command") {
    throw new Error(
      "Workspace artifact metadata must describe a skill or command",
    );
  }
  return {
    id: artifact.id,
    kind: artifact.kind,
    scope: artifact.scope,
    revision: artifact.revision,
    ...(artifact.name ? { name: artifact.name } : {}),
    ...(artifact.description
      ? { description: boundUtf8(artifact.description, MAX_DESCRIPTION_BYTES) }
      : {}),
  };
}

function toListedDiagnostic(
  diagnostic: NodeHostArtifactDiagnostic,
  roots: readonly WorkspaceArtifactRoot[],
): ListedDiagnostic {
  return {
    code: diagnostic.code,
    source: boundUtf8(
      diagnosticSource(diagnostic.path, roots),
      MAX_DIAGNOSTIC_PATH_BYTES,
    ),
    message: boundUtf8(diagnostic.message, MAX_DIAGNOSTIC_BYTES),
  };
}

function diagnosticSource(
  diagnosticPath: string,
  roots: readonly WorkspaceArtifactRoot[],
): string {
  for (const root of [...roots].sort(
    (left, right) => right.rootPath.length - left.rootPath.length,
  )) {
    const relative = path.relative(
      path.resolve(root.rootPath),
      path.resolve(diagnosticPath),
    );
    if (relative === "") return root.id;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `${root.id}:${relative.split(path.sep).join("/")}`;
    }
  }
  return "configured-root";
}

function sameTurn<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  invocation: HostToolExecutionContext<TPrincipal>,
): boolean {
  return (
    discovery.principal.tenantId === invocation.principal.tenantId &&
    discovery.principal.subjectId === invocation.principal.subjectId &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function toolError(code: string) {
  const payload = { error: code };
  return {
    modelContent: JSON.stringify(payload),
    displayContent: payload,
    isError: true,
  };
}
