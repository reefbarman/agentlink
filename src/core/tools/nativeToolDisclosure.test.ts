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

  it("advertises the exact deferred catalog through the discovery bridge", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("find_native_tools", "Discover deferred native tools"),
      definition("get_call_hierarchy"),
      definition("generate_image"),
      definition("show_notification"),
    ]);

    const discoveryTool = snapshot.inlineTools.find(
      (tool) => tool.name === "find_native_tools",
    );
    expect(discoveryTool?.description).toBe(
      "Discover deferred native tools Deferred native tools in this catalog: get_call_hierarchy, generate_image.",
    );
    expect(discoveryTool?.description).not.toContain("show_notification");
  });

  it("advertises an explicitly empty deferred catalog", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("find_native_tools", "Discover deferred native tools"),
      definition("read_file"),
    ]);

    expect(
      snapshot.inlineTools.find((tool) => tool.name === "find_native_tools")
        ?.description,
    ).toBe(
      "Discover deferred native tools Deferred native tools in this catalog: none.",
    );
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

  it("matches normalized names and ranks description query terms", () => {
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

  it("resolves punctuated explicit tool names and includes conceptual matches", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("codebase_search", "Semantic codebase search"),
      definition("get_repo_map", "Repository module map"),
      definition("get_module_neighbors", "Inspect neighboring modules"),
      definition("open_file", "Open a file in the editor"),
      definition("get_diagnostics", "Show diagnostics and errors"),
      definition("manage_memory", "Create durable memory"),
    ]);

    expect(
      discoverNativeTools(snapshot, {
        query: "`codebase_search`, get_repo_map.",
      }).tools.map((tool) => tool.name),
    ).toEqual(["codebase_search", "get_repo_map"]);
    expect(
      discoverNativeTools(snapshot, {
        query: "open_file and show diagnostics for src/x.ts",
      }).tools.map((tool) => tool.name),
    ).toEqual(["open_file", "get_diagnostics"]);
    expect(
      discoverNativeTools(snapshot, {
        query: "codebase_search get_repo_map get_module_neighbors open_file",
      }).tools.map((tool) => tool.name),
    ).toEqual([
      "codebase_search",
      "get_repo_map",
      "get_module_neighbors",
      "open_file",
    ]);
  });

  it("uses ranked OR matching when no explicit tool name is present", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_repo_map", "Repository module skeleton and imports"),
      definition("codebase_search", "Semantic code search by meaning"),
      definition("manage_memory", "Create durable memory"),
    ]);

    expect(
      discoverNativeTools(snapshot, {
        query: "semantic repository map",
      }).tools.map((tool) => tool.name),
    ).toEqual(["get_repo_map", "codebase_search"]);

    const firstPage = discoverNativeTools(snapshot, {
      query: "semantic repository map",
      limit: 1,
    });
    expect(firstPage.tools.map((tool) => tool.name)).toEqual(["get_repo_map"]);
    expect(firstPage).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
    expect(
      discoverNativeTools(snapshot, {
        query: "semantic repository map",
        limit: 1,
        offset: firstPage.nextOffset,
      }),
    ).toMatchObject({
      tools: [expect.objectContaining({ name: "codebase_search" })],
      total: 2,
      offset: 1,
    });
  });

  it("falls back to the authorized catalog when no useful query terms remain", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_repo_map", "Repository module map"),
      definition("manage_memory", "Create durable memory"),
    ]);

    expect(
      discoverNativeTools(snapshot, { query: "native tools" }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["get_repo_map", "manage_memory"]);
    expect(
      discoverNativeTools(snapshot, { query: "ui" }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["get_repo_map", "manage_memory"]);
  });

  it("prefers a direct partial-name match over conceptual ranking", () => {
    const snapshot = createNativeToolDisclosureSnapshot([
      definition("get_repo_map", "Repository module map"),
      definition("codebase_search", "Search repo content"),
    ]);

    expect(
      discoverNativeTools(snapshot, { query: "repo map" }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["get_repo_map"]);
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
