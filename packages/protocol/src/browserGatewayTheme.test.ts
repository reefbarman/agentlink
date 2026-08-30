import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isBrowserGatewayThemeSnapshot,
  type BrowserGatewayThemeSnapshot,
} from "./browserGatewayTheme.js";

describe("browser gateway theme protocol", () => {
  it("keeps the serializable theme snapshot stable", () => {
    expectTypeOf<BrowserGatewayThemeSnapshot>().toEqualTypeOf<{
      cssVariables: Record<string, string>;
      colorScheme?: "light" | "dark" | "hc" | "hc-light";
      themeLabel?: string;
      source?: "webview-dom" | "vscode-theme-api" | "baked-default";
    }>();
  });

  it.each(["light", "dark", "hc", "hc-light"] as const)(
    "accepts the %s color scheme",
    (colorScheme) => {
      expect(
        isBrowserGatewayThemeSnapshot({
          cssVariables: {
            "--vscode-editor-background": "#121314",
            "--vscode-font-size": "13px",
          },
          colorScheme,
          themeLabel: "Theme",
          source: "webview-dom",
        }),
      ).toBe(true);
    },
  );

  it("accepts empty CSS variables for partial bootstrap snapshots", () => {
    expect(isBrowserGatewayThemeSnapshot({ cssVariables: {} })).toBe(true);
  });

  it.each([
    null,
    undefined,
    "theme",
    {},
    { cssVariables: null },
    { cssVariables: "not-an-object" },
    { cssVariables: { color: "red" } },
    { cssVariables: { "--vscode-foreground": 123 } },
    { cssVariables: { "--other-foreground": "red" } },
  ])("rejects invalid theme snapshot %j", (value) => {
    expect(isBrowserGatewayThemeSnapshot(value)).toBe(false);
  });
});
