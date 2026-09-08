import * as fs from "node:fs";
import * as path from "node:path";

import {
  STATIC_ADAPTER_TOOL_NAMES,
  getAgentToolInventoryDefinitions,
  getAgentTools,
} from "./toolAdapter.js";
import { describe, expect, it } from "vitest";

import { TOOL_CAPABILITIES } from "../core/tools/toolCapabilities.js";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import { createHash } from "node:crypto";
import { todoTool } from "./todoTool.js";

const inventoryPath = path.resolve("scripts/tool-inventory.json");
function buildInventory() {
  const tools = [...getAgentToolInventoryDefinitions(), todoTool]
    .map((definition) => {
      const metadata = TOOL_CAPABILITIES[definition.name];
      if (!metadata) throw new Error(`Missing metadata: ${definition.name}`);
      return {
        name: definition.name,
        parameters: Object.keys(
          definition.input_schema.properties ?? {},
        ).sort(),
        cluster: metadata.cluster,
        sideEffect: metadata.sideEffect,
        devOnly: Boolean(
          metadata.devOnly || TOOL_REGISTRY[definition.name]?.devOnly,
        ),
        availability: metadata.availability.kind,
        definitionSource: metadata.definitionSource,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const content = {
    version: 1,
    source: "canonical-definitions",
    buildVariant: "all-static-definitions",
    includesDevOnly: true,
    parameterScope: "top-level-union",
    tools,
  };
  return {
    ...content,
    revision: createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex"),
  };
}

describe("canonical telemetry tool inventory", () => {
  it("covers static and internal definitions without duplicates", () => {
    const inventory = buildInventory();
    const names = inventory.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([...STATIC_ADAPTER_TOOL_NAMES, todoTool.name]),
    );
    expect(
      inventory.tools.find((tool) => tool.name === "get_background_result")
        ?.parameters,
    ).toContain("wait_seconds");
    expect(
      inventory.tools.find((tool) => tool.name === "set_task_status")
        ?.parameters,
    ).toContain("result");
    expect(
      inventory.tools.find((tool) => tool.name === "todo_write")?.parameters,
    ).toEqual(["todos"]);
    expect(
      inventory.tools.find((tool) => tool.name === "get_feedback")?.devOnly,
    ).toBe(true);
  });
  it("covers parameters from actual foreground and background definitions", () => {
    const inventory = new Map(
      buildInventory().tools.map((tool) => [tool.name, tool]),
    );
    for (const background of [false, true]) {
      const definitions = getAgentTools(
        undefined,
        undefined,
        background,
        undefined,
        undefined,
        undefined,
        undefined,
        ["search", "fetch"],
        true,
      );
      for (const definition of definitions) {
        expect(inventory.get(definition.name)?.parameters).toEqual(
          expect.arrayContaining(
            Object.keys(definition.input_schema.properties ?? {}),
          ),
        );
      }
    }
  });
  it("matches the generated artifact", () => {
    const inventory = buildInventory();
    if (process.env.AGENTLINK_UPDATE_TOOL_INVENTORY === "1") {
      fs.writeFileSync(
        inventoryPath,
        `${JSON.stringify(inventory, null, 2)}\n`,
      );
    }
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))).toEqual(
      inventory,
    );
  });
});
