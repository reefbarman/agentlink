import { describe, expect, it } from "vitest";
import {
  desktopTrayIcon,
  desktopWindowChrome,
  isSupportedDesktopPlatform,
} from "./desktopPlatform.js";

describe("desktop platform", () => {
  it("supports macOS and Linux only", () => {
    expect(isSupportedDesktopPlatform("darwin")).toBe(true);
    expect(isSupportedDesktopPlatform("linux")).toBe(true);
    expect(isSupportedDesktopPlatform("win32")).toBe(false);
  });

  it("keeps the window manager frame on Linux", () => {
    expect(desktopWindowChrome("darwin", "/a/icon.png")).toEqual({
      titleBarStyle: "hiddenInset",
    });
    expect(desktopWindowChrome("linux", "/a/icon.png")).toEqual({
      autoHideMenuBar: true,
      icon: "/a/icon.png",
    });
  });

  it("uses a template tray image on macOS and the colour icon on Linux", () => {
    const asset = (name: string) => `/dist/${name}`;
    expect(desktopTrayIcon("darwin", asset)).toEqual({
      path: "/dist/trayTemplate.png",
      template: true,
    });
    expect(desktopTrayIcon("linux", asset)).toEqual({
      path: "/dist/icon.png",
      template: false,
      size: 22,
    });
  });
});
