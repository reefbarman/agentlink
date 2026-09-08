import {
  applyDiffSchema,
  codebaseSearchSchema,
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
    ["codebase_search", codebaseSearchSchema.path],
    ["read_file", readFileSchema.query],
    ["list_files", listFilesSchema.query],
    ["search_files", searchFilesSchema.semantic],
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

  it("distinguishes external dependency names from external repository access", () => {
    expect(getRepoMapSchema.include_external.description).toContain(
      "does not index or read external repositories",
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

  it("uses one apply_diff grammar across the tool and input schema", () => {
    expect(TOOL_REGISTRY.apply_diff.description).toContain(
      APPLY_DIFF_INPUT_GRAMMAR,
    );
    expect(applyDiffSchema.diff.description).toBe(APPLY_DIFF_INPUT_GRAMMAR);
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
