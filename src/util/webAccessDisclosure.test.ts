import {
  WEB_ACCESS_DISCLOSURE_MESSAGE,
  WEB_ACCESS_DISCLOSURE_STATE_KEY,
  WEB_ACCESS_DISCLOSURE_VERSION,
  WEB_ACCESS_SETTINGS_ACTION,
  showWebAccessDisclosureOnce,
} from "./webAccessDisclosure.js";
import { describe, expect, it, vi } from "vitest";

function createDependencies(shownVersion = 0) {
  const state = {
    get: vi.fn((_key: string, defaultValue: number) =>
      shownVersion > 0 ? shownVersion : defaultValue,
    ),
    update: vi.fn(async () => undefined),
  };
  const showInformationMessage = vi.fn(
    async () => undefined as string | undefined,
  );
  const openSettings = vi.fn(async () => undefined);
  return { state, showInformationMessage, openSettings };
}

describe("showWebAccessDisclosureOnce", () => {
  it("persists and shows the default-on cost, privacy, and trust disclosure", async () => {
    const dependencies = createDependencies();

    await expect(showWebAccessDisclosureOnce(dependencies)).resolves.toBe(true);

    expect(dependencies.state.update).toHaveBeenCalledWith(
      WEB_ACCESS_DISCLOSURE_STATE_KEY,
      WEB_ACCESS_DISCLOSURE_VERSION,
    );
    expect(dependencies.showInformationMessage).toHaveBeenCalledWith(
      WEB_ACCESS_DISCLOSURE_MESSAGE,
      WEB_ACCESS_SETTINGS_ACTION,
    );
    expect(dependencies.state.update.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.showInformationMessage.mock.invocationCallOrder[0]!,
    );
    expect(WEB_ACCESS_DISCLOSURE_MESSAGE).toContain("web_search");
    expect(WEB_ACCESS_DISCLOSURE_MESSAGE).toContain("web_fetch");
    expect(WEB_ACCESS_DISCLOSURE_MESSAGE).toContain("provider charges");
    expect(WEB_ACCESS_DISCLOSURE_MESSAGE).toContain(
      "ordinary connected MCP tools",
    );
    expect(WEB_ACCESS_DISCLOSURE_MESSAGE).toContain("untrusted model input");
    expect(WEB_ACCESS_DISCLOSURE_MESSAGE).toContain("Disabled");
  });

  it("opens filtered settings when requested", async () => {
    const dependencies = createDependencies();
    dependencies.showInformationMessage.mockResolvedValue(
      WEB_ACCESS_SETTINGS_ACTION,
    );

    await showWebAccessDisclosureOnce(dependencies);

    expect(dependencies.openSettings).toHaveBeenCalledWith(
      "agentlink.webAccess",
    );
  });

  it("does not show a disclosure revision twice", async () => {
    const dependencies = createDependencies(WEB_ACCESS_DISCLOSURE_VERSION);

    await expect(showWebAccessDisclosureOnce(dependencies)).resolves.toBe(
      false,
    );

    expect(dependencies.state.update).not.toHaveBeenCalled();
    expect(dependencies.showInformationMessage).not.toHaveBeenCalled();
    expect(dependencies.openSettings).not.toHaveBeenCalled();
  });
});
