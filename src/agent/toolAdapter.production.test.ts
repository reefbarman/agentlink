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

  it("exposes Compose inline only when the production foreground gate is enabled", () => {
    const disabled = createNativeToolDisclosureSnapshot(getAgentTools());
    const enabled = createNativeToolDisclosureSnapshot(
      getAgentTools(
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        true,
      ),
    );
    const background = createNativeToolDisclosureSnapshot(
      getAgentTools(
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        true,
      ),
    );

    expect(disabled.inlineTools.map((tool) => tool.name)).not.toContain(
      "compose",
    );
    expect(disabled.deferredTools.map((tool) => tool.name)).not.toContain(
      "compose",
    );
    expect(enabled.inlineTools.map((tool) => tool.name)).toContain("compose");
    expect(enabled.deferredTools.map((tool) => tool.name)).not.toContain(
      "compose",
    );
    expect(background.inlineTools.map((tool) => tool.name)).not.toContain(
      "compose",
    );
  });
});
