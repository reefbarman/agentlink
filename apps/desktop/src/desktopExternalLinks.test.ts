import { describe, expect, it, vi } from "vitest";

import { externalBrowserUrl } from "./desktopExternalLinks.js";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

const local = ["http://127.0.0.1:47138"];

describe("externalBrowserUrl", () => {
  it("allows http and https links outside the local service", () => {
    expect(externalBrowserUrl("https://example.com/a?b=1", local)).toBe(
      "https://example.com/a?b=1",
    );
    expect(externalBrowserUrl("http://example.com", local)).toBe(
      "http://example.com/",
    );
  });

  it("blocks local service origins, other schemes and invalid URLs", () => {
    for (const url of [
      "http://127.0.0.1:47138/other",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "vscode://agentlink",
      "not a url",
    ]) {
      expect(externalBrowserUrl(url, local)).toBeNull();
    }
  });
});
