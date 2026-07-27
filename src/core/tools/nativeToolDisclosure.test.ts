import {
  NATIVE_TOOL_DISCOVERY_MAX_LIMIT,
  createNativeToolDisclosureSnapshot,
  discoverNativeTools,
  getDeferredNativeTool,
} from "./nativeToolDisclosure.js";
import { describe, expect, it } from "vitest";

import type { CoreToolDefinition } from "./types.js";

function definition(
  name: string,
  description = `${name} description`,
): CoreToolDefinition {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties: {
        value: { type: "string", description: `${name} value` },
      },
    },
  };
}

describe("native tool disclosure snapshots", () => {
  it("partitions canonical tools without changing source order", () => {
    const dynamicMcp = definition("demo__search");
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_call_hierarchy"),
      definition("ask_user"),
      dynamicMcp,
      definition("write_file"),
      definition("load_skill"),
      definition("show_notification"),
      definition("manage_memory"),
    ]);

    expect(snapshot.inlineTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      "demo__search",
      "write_file",
      "load_skill",
    ]);
    expect(snapshot.deferredTools.map((tool) => tool.name)).toEqual([
      "get_call_hierarchy",
      "manage_memory",
    ]);
    expect(snapshot.dormantToolNames).toEqual(["show_notification"]);
  });

  it("captures an immutable definition and schema snapshot", () => {
    const source = definition("get_call_hierarchy");
    const snapshot = createNativeToolDisclosureSnapshot([source]);
    const captured = snapshot.deferredTools[0];

    source.description = "changed";
    source.input_schema.properties = { changed: { type: "boolean" } };

    expect(captured?.description).toBe("get_call_hierarchy description");
    expect(captured?.input_schema.properties).toEqual({
      value: {
        type: "string",
        description: "get_call_hierarchy value",
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.deferredTools)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.input_schema)).toBe(true);
    expect(Object.isFrozen(captured?.input_schema.properties)).toBe(true);
  });

  it("discovers deferred tools with deterministic bounded pagination", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_call_hierarchy", "Inspect incoming and outgoing calls"),
      definition("get_type_hierarchy", "Inspect type inheritance"),
      definition("manage_memory", "Create and revise durable memory"),
      definition("present_images", "Show session images"),
    ]);

    const first = discoverNativeTools(snapshot, { limit: 2 });
    expect(first).toEqual({
      schemaVersion: 1,
      tools: [
        {
          name: "get_call_hierarchy",
          description: "Inspect incoming and outgoing calls",
          disclosure: "eligible",
        },
        {
          name: "get_type_hierarchy",
          description: "Inspect type inheritance",
          disclosure: "eligible",
        },
      ],
      total: 4,
      offset: 0,
      limit: 2,
      nextOffset: 2,
    });

    const second = discoverNativeTools(snapshot, { limit: 2, offset: 2 });
    expect(second.tools.map((tool) => tool.name)).toEqual([
      "manage_memory",
      "present_images",
    ]);
    expect(second.nextOffset).toBeUndefined();
  });

  it("matches normalized names and all description query terms", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_call_hierarchy", "Inspect incoming and outgoing calls"),
      definition("get_type_hierarchy", "Inspect type inheritance"),
      definition("manage_memory", "Create and revise durable memory"),
    ]);

    expect(
      discoverNativeTools(snapshot, { query: "call-hierarchy" }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["get_call_hierarchy"]);
    expect(
      discoverNativeTools(snapshot, { query: "durable revise" }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["manage_memory"]);
  });

  it("omits schemas by default and returns only frozen captured schemas on request", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_call_hierarchy"),
    ]);

    expect(
      discoverNativeTools(snapshot).tools[0]?.input_schema,
    ).toBeUndefined();
    const withSchema = discoverNativeTools(snapshot, {
      includeSchemas: true,
      limit: 2,
    });
    expect(withSchema.tools[0]?.input_schema).toBe(
      snapshot.deferredTools[0]?.input_schema,
    );
    expect(withSchema.tools[1]?.input_schema).toBeUndefined();
    expect(
      discoverNativeTools(snapshot, {
        includeSchemas: true,
        limit: 2,
        schemaLimit: 2,
      }).tools[1]?.input_schema,
    ).toBe(snapshot.deferredTools[1]?.input_schema);
    expect(Object.isFrozen(withSchema.tools)).toBe(true);
  });

  it("clamps invalid bounds and resolves only exact deferred names", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("ask_user"),
      definition("get_call_hierarchy"),
      definition("get_type_hierarchy"),
    ]);

    const result = discoverNativeTools(snapshot, {
      limit: Number.POSITIVE_INFINITY,
      offset: -100,
    });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);

    expect(
      discoverNativeTools(snapshot, {
        limit: NATIVE_TOOL_DISCOVERY_MAX_LIMIT + 1,
      }).limit,
    ).toBe(NATIVE_TOOL_DISCOVERY_MAX_LIMIT);
    expect(getDeferredNativeTool(snapshot, "get_call_hierarchy")?.name).toBe(
      "get_call_hierarchy",
    );
    expect(getDeferredNativeTool(snapshot, "ask_user")).toBeUndefined();
    expect(getDeferredNativeTool(snapshot, "unknown")).toBeUndefined();
  });
});
