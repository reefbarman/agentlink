import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import type { AssistantUpdateStatus } from "../../shared/assistantUpdates";
import { AssistantUpdates } from "./AssistantUpdates";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const release = (version: string, notes = `Notes for ${version}`) => ({
  version,
  tag: `v${version}`,
  channel: "stable" as const,
  releaseUrl: `https://github.com/example/releases/tag/v${version}`,
  notes,
});

function status(
  patch: Partial<AssistantUpdateStatus> = {},
): AssistantUpdateStatus {
  return {
    configured: true,
    managed: true,
    installedVersion: "1.0.0",
    installedCommit: "abcdef0123456789",
    updaterProtocol: 1,
    canRollback: true,
    rollbackVersion: "0.9.0",
    discovery: {
      status: "available",
      automaticChecks: true,
      includePreviews: false,
      checkedAt: 1_700_000_000_000,
      lastAttemptAt: 1_700_000_000_000,
      retryAt: null,
      stale: false,
      releases: [release("1.1.0"), release("1.2.0", "Second release notes")],
    },
    operation: null,
    ...patch,
  };
}

function stubFetch(responses: unknown[] | (() => unknown)) {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, init, body });
      const response =
        typeof responses === "function" ? responses() : responses.shift();
      if (response instanceof Error) throw response;
      const payload =
        typeof response === "object" &&
        response !== null &&
        "updaterProtocol" in response
          ? { status: response }
          : response;
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return calls;
}

describe("AssistantUpdates", () => {
  it("shows installed version, selectable releases and their notes", async () => {
    stubFetch([status()]);
    render(<AssistantUpdates pollMs={60_000} />);
    await screen.findByText("Installed: 1.0.0 (abcdef01)");
    expect(screen.getByText("1.1.0 is available.")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Assistant release" }),
      {
        target: { value: "1.2.0" },
      },
    );
    expect(
      screen.getByText("Release notes for 1.2.0").parentElement?.textContent,
    ).toContain("Second release notes");
  });

  it("submits exactly the release and installed version the confirmation displayed", async () => {
    const calls = stubFetch([status(), { configured: true }]);
    render(<AssistantUpdates pollMs={60_000} />);
    await screen.findByText("Installed: 1.0.0 (abcdef01)");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Assistant release" }),
      {
        target: { value: "1.2.0" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Update to 1.2.0" }));
    expect(
      screen.getByRole("heading", { name: "Update to 1.2.0?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/New work will pause while active work finishes/u),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back up and update" }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/apply"))).toBe(true),
    );
    expect(calls.find((call) => call.url.endsWith("/apply"))?.body).toEqual({
      version: "1.2.0",
      expectedInstalledVersion: "1.0.0",
      confirmed: true,
    });
  });

  it("cancels a confirmation when polling removes its release or changes the installed version", async () => {
    let polled = 0;
    const calls = stubFetch(() => {
      polled += 1;
      return polled === 1
        ? status()
        : status({
            installedVersion: "1.1.0",
            discovery: {
              ...status().discovery,
              releases: [release("1.3.0")],
            },
          });
    });
    render(<AssistantUpdates pollMs={15} />);
    await screen.findByText("Installed: 1.0.0 (abcdef01)");
    fireEvent.click(screen.getByRole("button", { name: "Update to 1.1.0" }));
    expect(
      screen.getByRole("heading", { name: "Update to 1.1.0?" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Update to 1.1.0?" }),
      ).toBeNull(),
    );
    expect(calls.some((call) => call.url.endsWith("/apply"))).toBe(false);
  });

  it("confirms rollback against the captured installed and rollback versions", async () => {
    const calls = stubFetch([status(), { configured: true }]);
    render(<AssistantUpdates pollMs={60_000} />);
    await screen.findByText("Installed: 1.0.0 (abcdef01)");
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    expect(
      screen.getByRole("heading", { name: "Restore 0.9.0?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/rollback"))).toBe(true),
    );
    expect(calls.find((call) => call.url.endsWith("/rollback"))?.body).toEqual({
      version: "0.9.0",
      expectedInstalledVersion: "1.0.0",
      confirmed: true,
    });
  });

  it("restores an active operation and progress after remount", async () => {
    const running = status({
      operation: {
        id: "op-1",
        kind: "update",
        fromVersion: "1.0.0",
        targetVersion: "1.2.0",
        phase: "reconnecting",
        startedAt: 1,
        updatedAt: 2,
      },
    });
    stubFetch([running, running]);
    const view = render(<AssistantUpdates pollMs={60_000} />);
    await screen.findByText("Reconnecting to the updated Assistant");
    expect(
      (
        screen.getByRole("button", {
          name: "Update to 1.1.0",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    view.unmount();
    render(<AssistantUpdates pollMs={60_000} />);
    expect(
      await screen.findByText("Reconnecting to the updated Assistant"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Work continues if this panel or browser is closed/u),
    ).toBeTruthy();
  });

  it("keeps unmanaged and unavailable installations read-only", async () => {
    stubFetch([status({ managed: false })]);
    const view = render(<AssistantUpdates pollMs={60_000} />);
    await screen.findByText(
      /Browser updates are not configured for this installation/u,
    );
    expect(screen.queryByRole("button", { name: /Update to/u })).toBeNull();
    view.unmount();
    stubFetch([
      status({ discovery: { ...status().discovery, status: "unavailable" } }),
    ]);
    render(<AssistantUpdates pollMs={60_000} />);
    await screen.findByText(/release check did not finish/u);
  });

  it("shows reconnect guidance and updater errors without exposing operations", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });
    render(<AssistantUpdates pollMs={60_000} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /temporarily unreachable/u,
    );
    expect(
      screen.queryByRole("button", { name: /shell|command|terminal/i }),
    ).toBeNull();

    cleanup();
    stubFetch([status({ error: "operator_attention" })]);
    render(<AssistantUpdates pollMs={60_000} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /operator attention/u,
    );
    expect(
      screen.queryByRole("button", { name: /shell|command|terminal/i }),
    ).toBeNull();
  });
});
