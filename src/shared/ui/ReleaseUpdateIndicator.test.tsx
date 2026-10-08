// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import { ReleaseUpdateIndicator } from "./ReleaseUpdateIndicator";
import type { ReleaseUpdateState } from "../../updates/releaseUpdateTypes";

afterEach(cleanup);
const state: ReleaseUpdateState = {
  identity: {
    product: "vscode",
    version: "1.0.0",
    target: "darwin-arm64",
    development: false,
  },
  status: "available",
  automaticChecks: true,
  lastAttemptAt: null,
  checkedAt: null,
  retryAt: null,
  dismissedVersion: null,
  stale: false,
  candidate: {
    version: "1.1.0",
    tag: "v1.1.0",
    target: "darwin-arm64",
    channel: "stable",
    releaseUrl: "",
    instructionsUrl: "",
  },
};
const base = {
  state,
  showDetails: true,
  onCheck: vi.fn(),
  onDismiss: vi.fn(),
  onOpenLink: vi.fn(),
};
describe("ReleaseUpdateIndicator", () => {
  it("has no install or restart button on a browser-only surface", () => {
    const view = render(<ReleaseUpdateIndicator {...base} />);
    expect(view.queryByRole("button", { name: "Install update" })).toBeNull();
    expect(view.queryByRole("button", { name: "Reload to finish" })).toBeNull();
    expect(view.getByText("Install this update from the host.")).toBeTruthy();
  });
  it("forwards an explicit install and disables it while downloading", () => {
    const onInstall = vi.fn();
    const view = render(
      <ReleaseUpdateIndicator {...base} onInstall={onInstall} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Install update" }));
    expect(onInstall).toHaveBeenCalledOnce();
    view.rerender(
      <ReleaseUpdateIndicator
        {...base}
        onInstall={onInstall}
        installState={{ phase: "downloading", total: 100, received: 50 }}
      />,
    );
    expect(
      (
        view.getByRole("button", {
          name: "Install update",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(view.getByText(/Downloading update.*50%/)).toBeTruthy();
  });
  it("hides install and highlights the reason when self-update is blocked", () => {
    const view = render(
      <ReleaseUpdateIndicator
        {...base}
        onInstall={vi.fn()}
        installState={{
          phase: "blocked",
          message: "Locally Team ID-signed apps cannot self-update.",
        }}
      />,
    );
    expect(view.queryByRole("button", { name: "Install update" })).toBeNull();
    const notice = view.getByText(/cannot self-update/);
    expect(notice.className).toContain("release-update-notice-warning");
  });
  it("offers restart separately, including when the candidate notice was dismissed", () => {
    const onRestart = vi.fn();
    const view = render(
      <ReleaseUpdateIndicator
        {...base}
        state={{ ...state, dismissedVersion: "1.1.0" }}
        onInstall={vi.fn()}
        onRestart={onRestart}
        installState={{ phase: "ready_to_restart", version: "1.1.0" }}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Reload to finish" }));
    expect(onRestart).toHaveBeenCalledOnce();
    expect(view.queryByRole("button", { name: "Install update" })).toBeNull();
  });
});
