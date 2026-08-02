/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fileOpenFailureMessage,
  recordFileLinkClick,
  resetFileLinkFeedbackForTests,
  resolveOpenFileRequest,
  showFileOpenFailure,
  trackOpenFileRequest,
} from "./fileLinkFeedback";

function clickTarget(path = "src/foo.ts"): HTMLElement {
  const anchor = document.createElement("a");
  anchor.textContent = path;
  document.body.appendChild(anchor);
  recordFileLinkClick(anchor, path);
  return anchor;
}

function activePopup(): HTMLElement | null {
  return document.body.querySelector(".file-link-open-feedback");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetFileLinkFeedbackForTests();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("fileOpenFailureMessage", () => {
  it("distinguishes missing files from other open failures", () => {
    expect(fileOpenFailureMessage("not_found")).toBe("File not found");
    expect(fileOpenFailureMessage("open_failed")).toBe(
      "Couldn't open this file",
    );
    expect(fileOpenFailureMessage(undefined)).toBe("Couldn't open this file");
  });
});

describe("showFileOpenFailure", () => {
  it("shows a transient popup over the recorded link and removes it", () => {
    clickTarget("src/foo.ts");

    expect(showFileOpenFailure("src/foo.ts", "not_found")).toBe(true);

    const popup = activePopup();
    expect(popup).not.toBeNull();
    expect(popup!.textContent).toBe("File not found");

    vi.advanceTimersByTime(3_000);
    expect(activePopup()).toBeNull();
  });

  it("returns false when no recent click matches the path", () => {
    clickTarget("src/foo.ts");

    expect(showFileOpenFailure("src/other.ts", "not_found")).toBe(false);
    expect(activePopup()).toBeNull();
  });

  it("returns false when the clicked link left the DOM", () => {
    const anchor = clickTarget("src/foo.ts");
    anchor.remove();

    expect(showFileOpenFailure("src/foo.ts", "not_found")).toBe(false);
    expect(activePopup()).toBeNull();
  });

  it("replaces an existing popup instead of stacking", () => {
    clickTarget("src/foo.ts");
    expect(showFileOpenFailure("src/foo.ts", "not_found")).toBe(true);
    expect(showFileOpenFailure("src/foo.ts", "open_failed")).toBe(true);

    const popups = document.body.querySelectorAll(".file-link-open-feedback");
    expect(popups).toHaveLength(1);
    expect(popups[0]!.textContent).toBe("Couldn't open this file");
  });
});

describe("open-file request correlation", () => {
  it("shows failure feedback for a tracked request", () => {
    clickTarget("src/foo.ts");
    trackOpenFileRequest("req-1", "src/foo.ts");

    resolveOpenFileRequest("req-1", false, "not_found");

    expect(activePopup()?.textContent).toBe("File not found");
  });

  it("shows nothing for successful or unknown results", () => {
    clickTarget("src/foo.ts");
    trackOpenFileRequest("req-1", "src/foo.ts");

    resolveOpenFileRequest("req-1", true);
    resolveOpenFileRequest("req-unknown", false, "not_found");

    expect(activePopup()).toBeNull();
  });

  it("resolves each request at most once", () => {
    clickTarget("src/foo.ts");
    trackOpenFileRequest("req-1", "src/foo.ts");

    resolveOpenFileRequest("req-1", false, "not_found");
    vi.advanceTimersByTime(3_000);
    resolveOpenFileRequest("req-1", false, "not_found");

    expect(activePopup()).toBeNull();
  });
});
