/** @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { BrowserGatewayApp } from "./BrowserGatewayApp";
import { h } from "preact";

const props = {
  authToken: "test-token",
  currentInstanceId: "default-window",
  workspaceName: "Default",
  routeByInstance: true,
  dataPlaneMode: "off" as const,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("reopens the last view in the browser shell", () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      close() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const mountShell = () =>
    render(h(BrowserGatewayApp, { ...props, browserShell: true }));

  mountShell();
  fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
  cleanup();
  window.sessionStorage.clear();
  mountShell();
  expect(screen.getByTitle("VS Code workspaces").hasAttribute("hidden")).toBe(
    false,
  );

  fireEvent.click(screen.getByRole("button", { name: "Ask AgentLink" }));
  cleanup();
  mountShell();
  expect(screen.queryByTitle("VS Code workspaces")).toBeNull();
});

it("restores the browser workspace and logical tab with fresh session storage", async () => {
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      close() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const instances = [
    { instanceId: "default-window", workspaceName: "Default" },
    { instanceId: "other-window", workspaceName: "Other" },
  ].map((instance) => ({
    ...instance,
    workspacePath: `/${instance.instanceId}`,
  }));
  const tabs = [1, 2].map((number) => ({
    tabId: `tab-${number}`,
    displayNumber: number,
    label: `Chat ${number}`,
    sessionId: `session-${number}`,
    placement: "docked",
    status: "idle",
    busy: false,
  }));
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, window.location.origin);
    if (url.pathname === "/api/instances") {
      return Response.json({
        currentInstanceId: props.currentInstanceId,
        instances,
      });
    }
    if (url.pathname === "/api/ui-state") {
      return Response.json({
        ui: { recentEvents: [], mcpStatusInfos: [] },
        session: {
          foreground: null,
          sessions: [],
          chatWorkspace: {
            controllerEpoch: "epoch",
            focusedTabId: "tab-1",
            tabs,
          },
        },
        background: [],
        diffs: [],
        theme: { cssVariables: {} },
      });
    }
    return new Response(null, { status: 404 });
  });

  const mountWorkspace = () =>
    render(
      h(BrowserGatewayApp, {
        ...props,
        workspaceOnly: true,
        browserWorkspace: true,
      }),
    );
  const otherChat = () => screen.getByRole("tab", { name: /Chat 2.*Other/ });

  mountWorkspace();
  await waitFor(() => expect(otherChat()).toBeTruthy());
  fireEvent.click(otherChat());
  await waitFor(() =>
    expect(otherChat().getAttribute("aria-selected")).toBe("true"),
  );

  cleanup();
  window.sessionStorage.clear();
  mountWorkspace();
  await waitFor(() =>
    expect(otherChat().getAttribute("aria-selected")).toBe("true"),
  );
});
