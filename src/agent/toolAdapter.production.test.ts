import { describe, expect, it, vi } from "vitest";

import { createNativeToolDisclosureSnapshot } from "../core/tools/nativeToolDisclosure.js";
import { getAgentTools } from "./toolAdapter.js";

vi.mock("../shared/buildFlags.js", () => ({ IS_DEV_BUILD: false }));

describe("getAgentTools production build", () => {
  it("omits every development feedback tool from provider and discovery definitions", () => {
    const disclosure = createNativeToolDisclosureSnapshot(getAgentTools());
    const providerNames = disclosure.inlineTools.map((tool) => tool.name);
    const deferredNames = disclosure.deferredTools.map((tool) => tool.name);

    for (const name of [
      "send_feedback",
      "get_feedback",
      "triage_feedback",
      "delete_feedback",
    ]) {
      expect(providerNames).not.toContain(name);
      expect(deferredNames).not.toContain(name);
    }
  });
});
