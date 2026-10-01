import {
  applyDiffSchema,
  executeCommandSchema,
  getModuleNeighborsSchema,
  getRepoMapSchema,
  listFilesSchema,
  readFileSchema,
  searchFilesSchema,
} from "./toolSchemas.js";
import { describe, expect, it } from "vitest";

import { APPLY_DIFF_INPUT_GRAMMAR } from "./applyDiffFormat.js";
import { TOOL_REGISTRY } from "./toolRegistry.js";

describe("TOOL_REGISTRY", () => {
  it.each([
    ["get_repo_map", getRepoMapSchema.path],
    ["get_module_neighbors", getModuleNeighborsSchema.path],
    ["search_files", searchFilesSchema.query],
  ] as const)(
    "advertises workspace-only indexing for %s",
    (name, parameter) => {
      const description = TOOL_REGISTRY[name].description;
      expect(description).toContain("within the current workspace folders");
      expect(description).toContain("external");
      expect(parameter.description).toContain(
        "within the current workspace folders",
      );
      expect(parameter.description).toMatch(/external/i);
    },
  );

  it("exposes one indexed-search entry point without retired fields", () => {
    expect(TOOL_REGISTRY).not.toHaveProperty("codebase_search");
    expect(searchFilesSchema).not.toHaveProperty("semantic");
    expect(readFileSchema).not.toHaveProperty("query");
    expect(listFilesSchema).not.toHaveProperty("query");
    expect(searchFilesSchema.regex.isOptional()).toBe(true);
    expect(searchFilesSchema.query.isOptional()).toBe(true);
    expect(searchFilesSchema.max_results.description).toContain(
      "300 for regex, 10 for query",
    );
  });

  it("distinguishes external dependency names from external repository access", () => {
    expect(getRepoMapSchema.include_external.description).toContain(
      "does not index or read external repositories",
    );
  });

  it("tells agents to call direct tools instead of searching the deferred catalog", () => {
    expect(TOOL_REGISTRY.find_native_tools.description).toContain(
      "Direct tools must be called by name",
    );
    expect(TOOL_REGISTRY.find_native_tools.description).toContain(
      "excluded from the current request",
    );
  });

  it("tells agents that execute_command already disables interactive pagers", () => {
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "AgentLink already disables interactive pagers consistently",
    );
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "do not add `GIT_PAGER=cat`",
    );
  });

  it("limits shell persistence to Native Agent terminals and explains sandbox env", () => {
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "sandbox commands always start fresh shells",
    );
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "Native Agent terminals retain intentional persistent-shell state",
    );
    expect(executeCommandSchema.terminal_name.description).toContain(
      "sandbox calls start fresh shells even when named or targeted",
    );
    expect(executeCommandSchema.env.description).toContain(
      "Sandbox calls do not retain prior exports",
    );
    expect(executeCommandSchema.env.description).toContain(
      "values are literal, not shell-expanded",
    );
    for (const description of [
      TOOL_REGISTRY.execute_command.description,
      executeCommandSchema.env.description,
    ]) {
      expect(description).toContain("PATH is host-managed");
      expect(description).toContain("inline");
      expect(description).toContain('export PATH="/desired/bin:$PATH"');
      expect(description).toContain("sandbox_preparation_failed");
      expect(description).not.toContain("including PATH");
    }
  });

  it("uses one apply_diff grammar across the tool and input schema", () => {
    expect(TOOL_REGISTRY.apply_diff.description).toContain(
      APPLY_DIFF_INPUT_GRAMMAR,
    );
    expect(applyDiffSchema.diff.description).toBe(APPLY_DIFF_INPUT_GRAMMAR);
    expect(APPLY_DIFF_INPUT_GRAMMAR).toContain(
      "Strip renderer // marker prefixes, not payload comments.",
    );
    expect(APPLY_DIFF_INPUT_GRAMMAR).toContain(
      "bare ======= line is literal payload",
    );
    expect(APPLY_DIFF_INPUT_GRAMMAR).toContain(
      "unified-diff input with an @@ hunk",
    );
  });

  it("advertises structural-protection recovery guidance", () => {
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "unsafe filesystem nodes in protected trees",
    );
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "structured `retry_guidance`",
    );
  });
});
