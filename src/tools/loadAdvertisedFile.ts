import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import { errorResult, jsonResult, type ToolResult } from "../shared/types.js";
import { resolveAndValidatePath } from "../util/paths.js";

function normalizeExistingPath(filePath: string): string {
  try {
    return path.normalize(fs.realpathSync(filePath));
  } catch {
    return path.normalize(path.resolve(filePath));
  }
}

export interface AllowedAdvertisedFile {
  name: string;
  filePath: string;
}

function createLegacyAdvertisedArtifactProvider(): AdvertisedArtifactProvider {
  return {
    resolvePath(inputPath) {
      return resolveAndValidatePath(inputPath).absolutePath;
    },
    normalizeExistingPath,
    readTextFile(filePath) {
      return fsp.readFile(filePath, "utf-8");
    },
  };
}

export async function loadAdvertisedFile(params: {
  path: string;
  advertisedFiles: AllowedAdvertisedFile[];
  kind: "skill" | "rule";
  pathProperty: "skillPath" | "rulePath";
  nameProperty: "skill_name" | "rule_name";
  allowlistLabel: string;
  contentTransform?: (raw: string) => string;
  artifactProvider?: AdvertisedArtifactProvider;
}): Promise<ToolResult> {
  try {
    const artifactProvider =
      params.artifactProvider ?? createLegacyAdvertisedArtifactProvider();
    const absolutePath = artifactProvider.resolvePath(params.path);
    const normalizedAbsolutePath =
      artifactProvider.normalizeExistingPath(absolutePath);
    const allowed = params.advertisedFiles.find((file) => {
      try {
        return (
          artifactProvider.normalizeExistingPath(file.filePath) ===
          normalizedAbsolutePath
        );
      } catch {
        return false;
      }
    });

    if (!allowed) {
      return errorResult(
        `${params.kind[0].toUpperCase()}${params.kind.slice(1)} path is not in the current session's advertised ${params.allowlistLabel} allowlist`,
        params.path ? { path: params.path } : undefined,
      );
    }

    const raw = await artifactProvider.readTextFile(absolutePath);
    const content = params.contentTransform?.(raw) ?? raw;

    return jsonResult(
      {
        [params.nameProperty]: allowed.name,
        [params.pathProperty]: absolutePath,
        content,
      },
      true,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      message,
      params.path ? { path: params.path } : undefined,
    );
  }
}
