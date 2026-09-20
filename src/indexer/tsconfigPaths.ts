import * as fs from "node:fs";
import * as path from "node:path";

import { canonicalizePath } from "../util/canonicalPath.js";
import { parseJsonWithComments } from "@agentlink/protocol/jsonc";
import { resolveContainedCodeIndexPath } from "./codeIndexPaths.js";

interface AliasConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsDirectory?: string;
}

export interface AliasCandidates {
  matched: boolean;
  bases: string[];
}

export type TsconfigPathResolver = (
  importer: string,
  specifier: string,
) => AliasCandidates;

/** One extraction/projection owns the cache, so config edits cannot leave stale aliases. */
export function createTsconfigPathResolver(
  workspaceRoot: string,
): TsconfigPathResolver {
  const root = canonicalizePath(workspaceRoot);
  const configs = new Map<string, AliasConfig | null>();
  const directories = new Map<string, AliasConfig | null>();
  const contained = (candidate: string) =>
    resolveContainedCodeIndexPath(root, candidate)?.absolutePath;
  const read = (candidate: string): Record<string, unknown> | undefined => {
    const file = contained(candidate);
    if (!file) return undefined;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1_048_576) return undefined;
      const text = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(text) > 1_048_576) return undefined;
      const value = parseJsonWithComments(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const exists = (candidate: string): boolean => {
    const file = contained(candidate);
    if (!file) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const resolveExtends = (
    reference: string,
    directory: string,
  ): string | undefined => {
    if (reference.startsWith(".") || path.isAbsolute(reference)) {
      const base = path.resolve(directory, reference);
      return [base, `${base}.json`].find(exists);
    }
    // Resolve config packages only from node_modules directories inside this workspace.
    const parts = reference.split("/");
    const packageLength = reference.startsWith("@") ? 2 : 1;
    if (parts.some((part) => !part || part === "." || part === ".."))
      return undefined;
    const packageName = parts.slice(0, packageLength).join("/");
    const subpath = parts.slice(packageLength).join("/");
    let current = directory;
    for (;;) {
      const packageRoot = path.join(current, "node_modules", packageName);
      if (subpath) {
        const base = path.join(packageRoot, subpath);
        const found = [
          base,
          `${base}.json`,
          path.join(base, "tsconfig.json"),
        ].find(exists);
        if (found) return found;
      } else {
        const manifest = read(path.join(packageRoot, "package.json"));
        const target =
          typeof manifest?.tsconfig === "string"
            ? manifest.tsconfig
            : "tsconfig.json";
        const found = path.resolve(packageRoot, target);
        if (exists(found)) return found;
      }
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current || !contained(path.join(parent, "tsconfig.json")))
        break;
      current = parent;
    }
    return undefined;
  };
  const load = (
    candidate: string,
    visiting = new Set<string>(),
  ): AliasConfig | null => {
    const file = contained(candidate);
    if (!file || visiting.has(file) || visiting.size >= 32) return null;
    if (configs.has(file)) return configs.get(file)!;
    const json = read(file);
    if (!json) return null;
    const next = new Set(visiting).add(file);
    let result: AliasConfig = {};
    const references =
      json.extends === undefined
        ? []
        : Array.isArray(json.extends)
          ? json.extends
          : [json.extends];
    for (const reference of references) {
      if (typeof reference !== "string") return null;
      const base = resolveExtends(reference, path.dirname(file));
      const inherited = base ? load(base, next) : null;
      if (!inherited) return null;
      result = { ...result, ...inherited };
    }
    const options = json.compilerOptions;
    if (
      options !== undefined &&
      (!options || typeof options !== "object" || Array.isArray(options))
    )
      return null;
    const compiler = options as Record<string, unknown> | undefined;
    if (compiler && Object.hasOwn(compiler, "baseUrl")) {
      if (typeof compiler.baseUrl !== "string") return null;
      result.baseUrl = path.resolve(path.dirname(file), compiler.baseUrl);
    }
    if (compiler && Object.hasOwn(compiler, "paths")) {
      if (
        !compiler.paths ||
        typeof compiler.paths !== "object" ||
        Array.isArray(compiler.paths)
      )
        return null;
      const mappings: Record<string, string[]> = Object.create(null);
      for (const [key, values] of Object.entries(compiler.paths)) {
        if (
          key.split("*").length > 2 ||
          !Array.isArray(values) ||
          !values.length ||
          values.some(
            (value) => typeof value !== "string" || value.split("*").length > 2,
          )
        )
          return null;
        mappings[key] = values;
      }
      result.paths = mappings;
      result.pathsDirectory = path.dirname(file);
    }
    configs.set(file, result);
    return result;
  };
  const nearest = (directory: string): AliasConfig | null => {
    if (directories.has(directory)) return directories.get(directory)!;
    let config: AliasConfig | null;
    const candidate = ["tsconfig.json", "jsconfig.json"]
      .map((name) => path.join(directory, name))
      .find((file) => {
        // An unsafe or broken nearest config still shadows ancestor configs.
        // load() rejects its canonical target before reading any content.
        try {
          fs.lstatSync(file);
          return true;
        } catch {
          return false;
        }
      });
    if (candidate) config = load(candidate);
    else if (directory === root) config = null;
    else {
      const parent = path.dirname(directory);
      config =
        parent !== directory && contained(path.join(parent, "tsconfig.json"))
          ? nearest(parent)
          : null;
    }
    directories.set(directory, config);
    return config;
  };
  return (importer, specifier) => {
    if (
      !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(importer) ||
      specifier.startsWith(".") ||
      path.isAbsolute(specifier) ||
      specifier.includes(":")
    )
      return { matched: false, bases: [] };
    const importerPath = contained(importer);
    if (!importerPath) return { matched: false, bases: [] };
    const config = nearest(path.dirname(importerPath));
    if (!config) return { matched: false, bases: [] };
    let selected: string | undefined;
    let capture = "";
    if (config.paths && Object.hasOwn(config.paths, specifier))
      selected = specifier;
    else
      for (const key of Object.keys(config.paths ?? {})) {
        const star = key.indexOf("*");
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (
          specifier.length < prefix.length + suffix.length ||
          !specifier.startsWith(prefix) ||
          !specifier.endsWith(suffix)
        )
          continue;
        if (selected === undefined || star > selected.indexOf("*")) {
          selected = key;
          capture = specifier.slice(
            prefix.length,
            specifier.length - suffix.length,
          );
        }
      }
    const bases =
      selected === undefined
        ? []
        : config.paths![selected].map((target) =>
            path.resolve(
              config.baseUrl ?? config.pathsDirectory!,
              target.replace("*", () => capture),
            ),
          );
    if (config.baseUrl) bases.push(path.resolve(config.baseUrl, specifier));
    return {
      matched: selected !== undefined,
      bases: bases.filter((base) => Boolean(contained(base))),
    };
  };
}
