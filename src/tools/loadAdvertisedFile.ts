import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import {
  loadAdvertisedFile as loadSharedAdvertisedFile,
  type AllowedAdvertisedFile,
} from "@agentlink/node-host";
import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import { resolveAndValidatePath } from "../util/paths.js";

export type { AllowedAdvertisedFile } from "@agentlink/node-host";

function normalizeExistingPath(filePath: string): string {
  try {
    return path.normalize(fs.realpathSync(filePath));
  } catch {
    return path.normalize(path.resolve(filePath));
  }
}

/** VS Code's resolver for callers that pass no artifact provider. */
export function createLegacyAdvertisedArtifactProvider(): AdvertisedArtifactProvider {
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

/**
 * Shared with every agent surface (`skillTools.ts` in `@agentlink/node-host`);
 * VS Code resolves workspace paths when no provider is passed.
 */
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
  return loadSharedAdvertisedFile({
    ...params,
    fallbackArtifactProvider: createLegacyAdvertisedArtifactProvider(),
  });
}
