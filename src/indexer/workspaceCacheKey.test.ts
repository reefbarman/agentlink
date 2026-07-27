import { describe, expect, it } from "vitest";

import { getWorkspaceCacheKey } from "./workspaceCacheKey.js";

describe("getWorkspaceCacheKey", () => {
  it.each([
    ["/Users/tristan/workspace/agentlink", "al-03569b57254f2ce2"],
    ["/Users/tristan/workspace/agentlink/", "al-bc899bf6e6d84e4a"],
    ["/users/tristan/workspace/agentlink", "al-5e1496487db7162f"],
    ["C:\\Users\\Tristan\\workspace\\agentlink", "al-e5fc9467197ee4dc"],
    ["C:/Users/Tristan/workspace/agentlink", "al-64103afee95b1fdd"],
  ])(
    "preserves the raw workspace path contract for %s",
    (workspacePath, expected) => {
      expect(getWorkspaceCacheKey(workspacePath)).toBe(expected);
    },
  );
});
