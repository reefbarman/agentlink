import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createHash, randomUUID } from "node:crypto";

import { resolveContainedPath } from "../core/agentPlugins/pathPolicy.js";
import { parseStrictJson } from "../core/agentPlugins/strictJson.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";
import { createNodePluginPackageFileSystem } from "./agentPluginFileSystem.js";
import {
  parseAgentPluginSource,
  type AgentPluginSource,
} from "./agentPluginSources.js";

const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const GIT_COMMIT = /^[a-f0-9]{40,64}$/u;
const MAX_PLUGIN_NAME_LENGTH = 64;

export type AgentPluginProjectDeclarationSource =
  | { readonly git: string; readonly commit: string }
  | { readonly path: string };

export interface AgentPluginProjectDeclaration {
  readonly name: string;
  readonly source: AgentPluginProjectDeclarationSource;
}

export interface AgentPluginProjectDeclarationDiagnostic {
  readonly code:
    | "declaration_invalid_json"
    | "declaration_duplicate_member"
    | "declaration_invalid_document"
    | "declaration_invalid_entry"
    | "declaration_source_unavailable";
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly index?: number;
  readonly name?: string;
}

export interface AgentPluginProjectDeclarationSnapshot {
  readonly declarationPath: string;
  readonly revision: string;
  readonly declarations: readonly AgentPluginProjectDeclaration[];
  readonly diagnostics: readonly AgentPluginProjectDeclarationDiagnostic[];
}

export type ResolvedAgentPluginProjectDeclaration =
  | {
      readonly status: "available";
      readonly declaration: AgentPluginProjectDeclaration;
      readonly source: AgentPluginSource;
    }
  | {
      readonly status: "unavailable";
      readonly declaration: AgentPluginProjectDeclaration;
      readonly diagnostic: AgentPluginProjectDeclarationDiagnostic;
    };

export class AgentPluginProjectDeclarationError extends Error {
  constructor(
    readonly code:
      | "project_scope_unavailable"
      | "declaration_revision_conflict"
      | "declaration_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AgentPluginProjectDeclarationError";
  }
}

export function getAgentPluginProjectDeclarationPath(
  scope: Readonly<SessionProjectScope>,
): string {
  if (!scope.rootPath) {
    throw new AgentPluginProjectDeclarationError(
      "project_scope_unavailable",
      `Project '${scope.displayName}' has no available local root for Agent Plugin declarations.`,
    );
  }
  return path.join(scope.rootPath, ".agentlink", "plugins.json");
}

export async function readAgentPluginProjectDeclarations(
  scope: Readonly<SessionProjectScope>,
): Promise<AgentPluginProjectDeclarationSnapshot> {
  const declarationPath = getAgentPluginProjectDeclarationPath(scope);
  let source: string;
  try {
    source = await fs.readFile(declarationPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        declarationPath,
        revision: declarationRevision(undefined),
        declarations: [],
        diagnostics: [],
      };
    }
    throw error;
  }
  return parseDeclarationDocument(declarationPath, source);
}

export async function resolveAgentPluginProjectDeclaration(
  scope: Readonly<SessionProjectScope>,
  declaration: Readonly<AgentPluginProjectDeclaration>,
): Promise<ResolvedAgentPluginProjectDeclaration> {
  if ("git" in declaration.source) {
    try {
      const parsed = await parseAgentPluginSource(
        `git+${declaration.source.git}`,
      );
      if (parsed.kind !== "git") throw new Error("Source is not a Git remote.");
      return {
        status: "available",
        declaration,
        source: { ...parsed, commit: declaration.source.commit },
      };
    } catch (error) {
      return unavailableDeclaration(
        declaration,
        `Declared Git source is invalid: ${errorMessage(error)}`,
      );
    }
  }

  if (!scope.rootPath) {
    return unavailableDeclaration(
      declaration,
      `Project '${scope.displayName}' has no available local root.`,
    );
  }
  const declaredPath = declaration.source.path;
  if (path.isAbsolute(declaredPath)) {
    return unavailableDeclaration(
      declaration,
      "Declared plugin paths must be relative to the owning workspace folder.",
    );
  }
  const resolved = await resolveContainedPath(
    createNodePluginPackageFileSystem(),
    scope.rootPath,
    path.resolve(scope.rootPath, declaredPath),
  );
  if (!resolved.ok) {
    return unavailableDeclaration(
      declaration,
      `Declared plugin path is unsafe: ${resolved.message}`,
    );
  }
  if (resolved.missingSegments.length > 0) {
    return unavailableDeclaration(
      declaration,
      `Declared plugin path is unavailable: ${declaredPath}`,
    );
  }
  try {
    const stat = await fs.stat(resolved.resolvedPath);
    if (!stat.isDirectory()) {
      return unavailableDeclaration(
        declaration,
        "Declared plugin paths must resolve to a directory.",
      );
    }
  } catch (error) {
    return unavailableDeclaration(
      declaration,
      `Declared plugin path is unavailable: ${errorMessage(error)}`,
    );
  }
  return {
    status: "available",
    declaration,
    source: {
      kind: "local-directory",
      path: resolved.resolvedPath,
      display: declaredPath,
      workspaceRelativePath: normalizeRelativePath(declaredPath),
    },
  };
}

export async function upsertAgentPluginProjectDeclaration(request: {
  readonly scope: Readonly<SessionProjectScope>;
  readonly declaration: Readonly<AgentPluginProjectDeclaration>;
  readonly expectedRevision: string;
}): Promise<AgentPluginProjectDeclarationSnapshot> {
  validateDeclaration(request.declaration, -1);
  const current = await readAgentPluginProjectDeclarations(request.scope);
  if (
    current.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new AgentPluginProjectDeclarationError(
      "declaration_invalid",
      `Cannot update malformed Agent Plugin declarations at ${current.declarationPath}.`,
    );
  }
  if (current.revision !== request.expectedRevision) {
    throw new AgentPluginProjectDeclarationError(
      "declaration_revision_conflict",
      "Agent Plugin declarations changed before the update could be saved.",
    );
  }
  const declarations = current.declarations.filter(
    (declaration) => declaration.name !== request.declaration.name,
  );
  declarations.push(cloneDeclaration(request.declaration));
  declarations.sort((left, right) => left.name.localeCompare(right.name));
  const source = `${JSON.stringify({ plugins: declarations }, null, 2)}\n`;
  await writeDeclarationAtomic(current.declarationPath, source);
  return parseDeclarationDocument(current.declarationPath, source);
}

function parseDeclarationDocument(
  declarationPath: string,
  source: string,
): AgentPluginProjectDeclarationSnapshot {
  const revision = declarationRevision(source);
  const parsed = parseStrictJson(source);
  if (!parsed.ok) {
    return {
      declarationPath,
      revision,
      declarations: [],
      diagnostics: [
        {
          code: "declaration_invalid_json",
          severity: "error",
          message: `Invalid Agent Plugin declaration JSON: ${parsed.error.message}`,
        },
      ],
    };
  }
  if (parsed.duplicateMembers.length > 0) {
    return {
      declarationPath,
      revision,
      declarations: [],
      diagnostics: parsed.duplicateMembers.map((duplicate) => ({
        code: "declaration_duplicate_member" as const,
        severity: "error" as const,
        message: duplicate.message,
      })),
    };
  }
  if (!isRecord(parsed.value) || !hasExactKeys(parsed.value, ["plugins"])) {
    return invalidDocument(
      declarationPath,
      revision,
      "Agent Plugin declarations must contain only a 'plugins' array.",
    );
  }
  if (!Array.isArray(parsed.value.plugins)) {
    return invalidDocument(
      declarationPath,
      revision,
      "Agent Plugin declaration 'plugins' must be an array.",
    );
  }

  const declarations: AgentPluginProjectDeclaration[] = [];
  const diagnostics: AgentPluginProjectDeclarationDiagnostic[] = [];
  const names = new Set<string>();
  parsed.value.plugins.forEach((value, index) => {
    try {
      const declaration = validateDeclaration(value, index);
      if (names.has(declaration.name)) {
        throw new Error(
          `Plugin '${declaration.name}' is declared more than once.`,
        );
      }
      names.add(declaration.name);
      declarations.push(declaration);
    } catch (error) {
      diagnostics.push({
        code: "declaration_invalid_entry",
        severity: "error",
        message: errorMessage(error),
        index,
        ...(isRecord(value) && typeof value.name === "string"
          ? { name: value.name }
          : {}),
      });
    }
  });
  return { declarationPath, revision, declarations, diagnostics };
}

function validateDeclaration(
  value: unknown,
  index: number,
): AgentPluginProjectDeclaration {
  const prefix = index < 0 ? "Declaration" : `Declaration ${index + 1}`;
  if (!isRecord(value) || !hasExactKeys(value, ["name", "source"])) {
    throw new Error(`${prefix} must contain only 'name' and 'source'.`);
  }
  if (
    typeof value.name !== "string" ||
    value.name.length > MAX_PLUGIN_NAME_LENGTH ||
    !PLUGIN_NAME.test(value.name)
  ) {
    throw new Error(`${prefix} has an invalid Agent Plugins 1.0.0 name.`);
  }
  if (!isRecord(value.source)) {
    throw new Error(`${prefix} has an invalid source.`);
  }
  if (hasExactKeys(value.source, ["git", "commit"])) {
    if (
      typeof value.source.git !== "string" ||
      !value.source.git ||
      typeof value.source.commit !== "string" ||
      !GIT_COMMIT.test(value.source.commit)
    ) {
      throw new Error(`${prefix} has an invalid pinned Git source.`);
    }
    return {
      name: value.name,
      source: { git: value.source.git, commit: value.source.commit },
    };
  }
  if (hasExactKeys(value.source, ["path"])) {
    if (
      typeof value.source.path !== "string" ||
      !value.source.path ||
      path.isAbsolute(value.source.path) ||
      value.source.path.includes("\\") ||
      value.source.path
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(
        `${prefix} has an invalid workspace-relative path source.`,
      );
    }
    return { name: value.name, source: { path: value.source.path } };
  }
  throw new Error(`${prefix} source must be pinned Git or a relative path.`);
}

async function writeDeclarationAtomic(
  declarationPath: string,
  source: string,
): Promise<void> {
  const directory = path.dirname(declarationPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.plugins.json.tmp-${process.pid}-${randomUUID()}`,
  );
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  let ownsTemporaryPath = true;
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, declarationPath);
    ownsTemporaryPath = false;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (ownsTemporaryPath) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function unavailableDeclaration(
  declaration: Readonly<AgentPluginProjectDeclaration>,
  message: string,
): ResolvedAgentPluginProjectDeclaration {
  return {
    status: "unavailable",
    declaration: cloneDeclaration(declaration),
    diagnostic: {
      code: "declaration_source_unavailable",
      severity: "warning",
      message,
      name: declaration.name,
    },
  };
}

function invalidDocument(
  declarationPath: string,
  revision: string,
  message: string,
): AgentPluginProjectDeclarationSnapshot {
  return {
    declarationPath,
    revision,
    declarations: [],
    diagnostics: [
      { code: "declaration_invalid_document", severity: "error", message },
    ],
  };
}

function cloneDeclaration(
  declaration: Readonly<AgentPluginProjectDeclaration>,
): AgentPluginProjectDeclaration {
  return {
    name: declaration.name,
    source:
      "git" in declaration.source
        ? {
            git: declaration.source.git,
            commit: declaration.source.commit,
          }
        : { path: declaration.source.path },
  };
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function declarationRevision(source: string | undefined): string {
  return createHash("sha256")
    .update(source === undefined ? "missing\0" : `present\0${source}`)
    .digest("hex");
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
