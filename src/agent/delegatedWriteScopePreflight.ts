import * as path from "path";

import { canonicalizePath, isPathWithinRoot } from "../util/paths.js";

import type { PathRule } from "../approvals/PathRuleStore.js";

/**
 * Read-only view of the authority a delegated child inherits. Delegated
 * outside-workspace writes need BOTH path trust and file-write authority at
 * dispatch (see `enforceDelegatedPathPolicy`), and a child cannot raise its own
 * prompt for either.
 */
export interface DelegatedWriteAuthorityReader {
  isPathTrusted(filePath: string): boolean;
  isWriteAllowed(filePath: string): boolean;
  pathRules(): readonly PathRule[];
  writeRules(filePath: string): readonly PathRule[];
}

/** Built-in modes whose tool inventory has no file-edit tools. */
export const NON_WRITING_DELEGATION_MODES: ReadonlySet<string> = new Set([
  "ask",
  "review",
  "debug",
]);

export type DelegatedWriteAuthorityGap = "path_trust" | "write_authority";

export interface DelegatedWriteScopeAssessment {
  /** Owned scopes no existing rule can reach: every write there is denied. */
  unavailable: Array<{
    ownedPath: string;
    resolvedPath: string;
    missing: DelegatedWriteAuthorityGap[];
  }>;
  /** Owned scopes where only narrower rules exist beneath the directory. */
  warnings: string[];
}

const GLOB_CHARACTERS = /[*?[\]{}()!+@]/;

function normalizeRulePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsoluteRulePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

/** Longest literal directory a rule pattern is anchored to. */
function ruleLiteralBase(rule: PathRule): string {
  const pattern = normalizeRulePath(rule.pattern);
  if (rule.mode !== "glob") return pattern.replace(/\/+$/, "");
  const globIndex = pattern.search(GLOB_CHARACTERS);
  if (globIndex === -1) return pattern.replace(/\/+$/, "");
  const literal = pattern.slice(0, globIndex);
  const slash = literal.lastIndexOf("/");
  return slash === -1 ? "" : literal.slice(0, slash) || "/";
}

/**
 * Conservative: true unless the rule provably cannot match the scope or any
 * path beneath it. Rule matching is string-based, so a relative literal
 * pattern never matches an absolute outside-workspace path.
 */
function ruleMayReachScope(rule: PathRule, scopeForms: string[]): boolean {
  const base = ruleLiteralBase(rule);
  if (base === "") return true;
  if (!isAbsoluteRulePath(base)) return false;
  if (base === "/") return true;
  return scopeForms.some(
    (scope) =>
      scope === base ||
      scope.startsWith(`${base}/`) ||
      base.startsWith(`${scope}/`),
  );
}

/**
 * Spawn-time preflight for native writable delegations. Rejects only owned
 * scopes that are provably unwritable for the child; directory scopes with
 * narrower grants beneath them receive a warning instead. Dispatch-time
 * enforcement remains authoritative either way.
 */
export function assessDelegatedWriteScopes(args: {
  ownedPaths: readonly string[];
  executionRoot: string;
  workspaceRoots: readonly string[];
  authority: DelegatedWriteAuthorityReader;
}): DelegatedWriteScopeAssessment {
  const roots = [args.executionRoot, ...args.workspaceRoots].map((root) =>
    path.resolve(root),
  );
  const canonicalRoots = roots.map((root) => canonicalizePath(root));
  const insideWorkspace = (candidate: string) => {
    const canonical = canonicalizePath(candidate);
    return (
      roots.some((root) => isPathWithinRoot(candidate, root)) ||
      canonicalRoots.some((root) => isPathWithinRoot(canonical, root))
    );
  };

  const assessment: DelegatedWriteScopeAssessment = {
    unavailable: [],
    warnings: [],
  };
  for (const ownedPath of args.ownedPaths) {
    if (!ownedPath.trim()) continue;
    // Dispatch resolves relative scopes against every workspace root, so a
    // relative scope is outside only when no root resolution lands inside.
    const candidates = path.isAbsolute(ownedPath)
      ? [path.resolve(ownedPath)]
      : roots.map((root) => path.resolve(root, ownedPath));
    if (candidates.some(insideWorkspace)) continue;

    const resolvedPath = candidates[0]!;
    const forms = [
      ...new Set([
        normalizeRulePath(resolvedPath),
        normalizeRulePath(canonicalizePath(resolvedPath)),
      ]),
    ];
    const trusted = forms.some((form) => args.authority.isPathTrusted(form));
    const writable = forms.some((form) => args.authority.isWriteAllowed(form));
    if (trusted && writable) continue;

    const trustReachable =
      trusted ||
      args.authority.pathRules().some((rule) => ruleMayReachScope(rule, forms));
    const writeReachable =
      writable ||
      args.authority
        .writeRules(resolvedPath)
        .some((rule) => ruleMayReachScope(rule, forms));
    const missing: DelegatedWriteAuthorityGap[] = [
      ...(trustReachable ? [] : (["path_trust"] as const)),
      ...(writeReachable ? [] : (["write_authority"] as const)),
    ];
    if (missing.length > 0) {
      assessment.unavailable.push({ ownedPath, resolvedPath, missing });
      continue;
    }
    assessment.warnings.push(
      `ownedPaths entry ${ownedPath} is outside the workspace roots and the inherited approvals only cover some paths beneath it; the child's writes elsewhere under it will be denied.`,
    );
  }
  return assessment;
}

export function formatUnavailableDelegatedWriteScopes(
  unavailable: DelegatedWriteScopeAssessment["unavailable"],
): string {
  const details = unavailable
    .map(
      ({ ownedPath, resolvedPath, missing }) =>
        `${ownedPath}${resolvedPath !== ownedPath ? ` (${resolvedPath})` : ""}: missing ${missing
          .map((gap) =>
            gap === "path_trust" ? "path trust" : "write approval",
          )
          .join(" and ")}`,
    )
    .join("; ");
  return `Background spawn rejected: ownedPaths outside the workspace roots cannot be written by a background agent without inherited path trust and write approval, and the child cannot request them itself. ${details}. ownedPaths restrict a child's writes; they do not grant access. Add the directory as a workspace folder, make those edits in the foreground (which can request approval), or grant path trust and a write rule for it before spawning. Read-only delegation of the same paths is unaffected.`;
}
