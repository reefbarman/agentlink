import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVscodeWebImageRetrievalAvailable,
  readVscodeWebImagePolicy,
} from "./vscodeWebImageTools.js";

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => settings.get(key),
    }),
  },
}));

describe("VS Code web image policy", () => {
  beforeEach(() => {
    settings.clear();
  });

  it("defaults to public image retrieval without prompting", () => {
    expect(readVscodeWebImagePolicy()).toEqual({
      mode: "enabled",
      allowedDomains: [],
      blockedDomains: [],
    });
    expect(isVscodeWebImageRetrievalAvailable()).toBe(true);
  });

  it("honours the explicit setting and domain lists", () => {
    settings.set("webAccess.imageRetrieval", "prompt");
    settings.set("webAccess.blockedDomains", ["example.com"]);
    expect(readVscodeWebImagePolicy()).toMatchObject({
      mode: "prompt",
      blockedDomains: ["example.com"],
    });
  });

  it("hides the tools when image retrieval or AgentLink page access is off", () => {
    settings.set("webAccess.imageRetrieval", "disabled");
    expect(isVscodeWebImageRetrievalAvailable()).toBe(false);

    settings.set("webAccess.imageRetrieval", "enabled");
    settings.set("webAccess.fetchBackend", "disabled");
    expect(isVscodeWebImageRetrievalAvailable()).toBe(false);
  });
});
