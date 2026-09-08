import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function loadToolInventory(
  inventoryPath = new URL("./tool-inventory.json", import.meta.url),
) {
  const artifact = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const { revision, ...content } = artifact;
  if (
    content.version !== 1 ||
    content.source !== "canonical-definitions" ||
    content.buildVariant !== "all-static-definitions" ||
    content.includesDevOnly !== true ||
    content.parameterScope !== "top-level-union" ||
    !Array.isArray(content.tools) ||
    revision !==
      createHash("sha256").update(JSON.stringify(content)).digest("hex")
  ) {
    throw new Error(
      "Invalid tool inventory; run npm run telemetry:inventory:generate",
    );
  }
  const knownTools = new Map();
  const knownParameters = new Map();
  for (const tool of content.tools) {
    if (
      typeof tool.name !== "string" ||
      knownTools.has(tool.name) ||
      !Array.isArray(tool.parameters) ||
      !tool.parameters.every((key) => typeof key === "string")
    )
      throw new Error("Invalid tool inventory entry");
    knownTools.set(tool.name, {
      known: true,
      cluster: tool.cluster,
      sideEffect: tool.sideEffect,
      devOnly: tool.devOnly,
    });
    knownParameters.set(tool.name, tool.parameters);
  }
  return {
    knownTools,
    knownParameters,
    metadata: {
      version: content.version,
      revision,
      source: content.source,
      buildVariant: content.buildVariant,
      includesDevOnly: content.includesDevOnly,
      parameterScope: content.parameterScope,
    },
  };
}
