import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BROWSER_GATEWAY_COLOR_SCHEMES,
  BROWSER_GATEWAY_THEME_SOURCES,
  isBrowserGatewayThemeSnapshot,
  type BrowserGatewayColorScheme,
  type BrowserGatewayThemeSnapshot,
  type BrowserGatewayThemeState,
} from "./browserGatewayTheme.js";

describe("browser gateway theme protocol", () => {
  it("pins and freezes the complete color-scheme set", () => {
    expect(BROWSER_GATEWAY_COLOR_SCHEMES).toEqual([
      "light",
      "dark",
      "hc",
      "hc-light",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_COLOR_SCHEMES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_COLOR_SCHEMES as unknown as string[]).push("other"),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayColorScheme>().toEqualTypeOf<
      "light" | "dark" | "hc" | "hc-light"
    >();
  });

  it("pins and freezes the complete theme-source set", () => {
    expect(BROWSER_GATEWAY_THEME_SOURCES).toEqual([
      "webview-dom",
      "vscode-theme-api",
      "baked-default",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_THEME_SOURCES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_THEME_SOURCES as unknown as string[]).push("other"),
    ).toThrow(TypeError);
  });

  it("keeps the serializable theme snapshot stable", () => {
    expectTypeOf<BrowserGatewayThemeSnapshot>().toEqualTypeOf<{
      cssVariables: Record<string, string>;
      colorScheme?: "light" | "dark" | "hc" | "hc-light";
      themeLabel?: string;
      source?: "webview-dom" | "vscode-theme-api" | "baked-default";
    }>();
  });

  it("pins the complete relay theme-state contract", () => {
    expectTypeOf<BrowserGatewayThemeState>().toEqualTypeOf<{
      revision: string;
      colorScheme: BrowserGatewayColorScheme;
      variables: Array<{ name: string; value: string }>;
    }>();
  });

  it.each(BROWSER_GATEWAY_COLOR_SCHEMES)(
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

  it.each(BROWSER_GATEWAY_THEME_SOURCES)(
    "accepts the %s theme source",
    (source) => {
      expect(
        isBrowserGatewayThemeSnapshot({
          cssVariables: {},
          source,
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
    { cssVariables: [] },
    { cssVariables: new Date() },
    { cssVariables: { color: "red" } },
    { cssVariables: { "--vscode-foreground": 123 } },
    { cssVariables: { "--other-foreground": "red" } },
    { cssVariables: {}, colorScheme: "other" },
    { cssVariables: {}, themeLabel: 1 },
    { cssVariables: {}, source: "other" },
  ])("rejects invalid theme snapshot %j", (value) => {
    expect(isBrowserGatewayThemeSnapshot(value)).toBe(false);
  });
});
