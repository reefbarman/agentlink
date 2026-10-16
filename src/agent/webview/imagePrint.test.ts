// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canPrintImage, printImage } from "./imagePrint";

describe("imagePrint", () => {
  afterEach(() => {
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("is unavailable inside VS Code webviews", () => {
    expect(canPrintImage()).toBe(true);
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi =
      () => ({});
    expect(canPrintImage()).toBe(false);
  });

  it("prints only the image from a temporary frame and removes it afterwards", async () => {
    const printed = printImage("data:image/png;base64,YWJjZA==", "cat.png");
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    const frameWindow = frame.contentWindow!;
    vi.spyOn(frameWindow, "focus").mockImplementation(() => {});
    const print = vi.spyOn(frameWindow, "print").mockImplementation(() => {});
    const image = frame.contentDocument!.querySelector("img")!;

    expect(frame.contentDocument!.title).toBe("cat.png");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,YWJjZA==");

    image.dispatchEvent(new Event("load"));
    await printed;
    expect(print).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe")).toBe(frame);

    frameWindow.dispatchEvent(new Event("afterprint"));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("rejects and cleans up when the image fails to load", async () => {
    const printed = printImage("data:image/png;base64,broken", "broken.png");
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    frame
      .contentDocument!.querySelector("img")!
      .dispatchEvent(new Event("error"));
    await expect(printed).rejects.toThrow("Image failed to load");
    expect(document.querySelector("iframe")).toBeNull();
  });
});
