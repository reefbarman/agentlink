import {
  AssistantProjectSwitcher,
  Dialog,
  ProjectSettingsDialog,
  parseAllowList,
  summarizeProjectActivity,
} from "./AssistantProjects";
import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const project = (
  id: string,
  activity?: { running: number; needsYou: number; unread: number },
) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  origin: "app" as const,
  path: `/srv/projects/${id}`,
  repositories: [],
  settings: {},
  ...(activity ? { activity } : {}),
});

describe("Dialog keyboard navigation", () => {
  it("contains keyboard focus and restores the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <Dialog title="Test panel" onClose={onClose}>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("Save"));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("wraps from an expandable validation row and skips hidden controls", () => {
    render(
      <Dialog title="Checks" onClose={() => {}}>
        <details>
          <summary>Validation output</summary>
          <button type="button">Hidden output action</button>
        </details>
        <input type="hidden" />
      </Dialog>,
    );
    const summary = screen.getByText("Validation output");
    const hidden = screen.getByText("Hidden output action");
    // jsdom does not implement layout visibility. In a real browser a button
    // inside closed details has checkVisibility() === false.
    hidden.checkVisibility = () => false;
    summary.focus();
    fireEvent.keyDown(summary, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(summary);
  });

  it("only dismisses the topmost panel and does not dismiss while busy", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const { rerender } = render(
      <>
        <Dialog title="Outer" onClose={outerClose}>
          Outer
        </Dialog>
        <Dialog title="Inner" onClose={innerClose} busy>
          Inner
        </Dialog>
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(outerClose).not.toHaveBeenCalled();
    expect(innerClose).not.toHaveBeenCalled();
    rerender(
      <>
        <Dialog title="Outer" onClose={outerClose}>
          Outer
        </Dialog>
        <Dialog title="Inner" onClose={innerClose}>
          Inner
        </Dialog>
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(outerClose).not.toHaveBeenCalled();
    expect(innerClose).toHaveBeenCalledTimes(1);
  });
});

describe("summarizeProjectActivity", () => {
  it("reports the most urgent status with counts, or nothing when quiet", () => {
    expect(
      summarizeProjectActivity([
        project("a", { running: 0, needsYou: 0, unread: 0 }),
        project("b"),
      ]),
    ).toBeNull();
    expect(
      summarizeProjectActivity([
        project("a", { running: 2, needsYou: 0, unread: 1 }),
      ]),
    ).toEqual({ activity: "running", label: "2 working, 1 new reply" });
    expect(
      summarizeProjectActivity([
        project("a", { running: 1, needsYou: 0, unread: 2 }),
        project("b", { running: 0, needsYou: 1, unread: 0 }),
      ]),
    ).toEqual({
      activity: "needs-you",
      label: "1 needs you, 1 working, 2 new replies",
    });
  });
});

describe("AssistantProjectSwitcher", () => {
  it("flags other projects' activity on the switcher and in the menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              activeProjectId: "home",
              canCreate: false,
              canClone: false,
              projects: [
                // The current project's status is in the chat list instead.
                project("home", { running: 1, needsYou: 0, unread: 0 }),
                project("work", { running: 0, needsYou: 1, unread: 0 }),
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(<AssistantProjectSwitcher reloadPage={vi.fn()} />);
    const button = await screen.findByRole("button", {
      name: "Project Home (other projects: 1 needs you)",
    });
    fireEvent.click(button);
    await waitFor(() =>
      screen.getByRole("menuitemradio", { name: "Work (1 needs you)" }),
    );
    screen.getByRole("menuitemradio", { name: "Home (1 working)" });
  });
});

describe("ProjectSettingsDialog network", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("splits extra sites by line or comma", () => {
    expect(parseAllowList(" a.example.com\n\n*.b.org, c.net ,")).toEqual([
      "a.example.com",
      "*.b.org",
      "c.net",
    ]);
  });

  it("loads the preset, saves a new one with extra sites, and shows the server's detail", async () => {
    const posts: unknown[] = [];
    const loaded = {
      ...project("home"),
      settings: { network: { preset: "open", allow: ["docs.example.com"] } },
    };
    let reject = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/models")) return json({ models: [] });
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return reject
            ? json(
                {
                  error: "network_allow_invalid",
                  detail: '"http://x/" is not a host name',
                },
                400,
              )
            : json({ project: loaded });
        }
        return json({
          project: loaded,
          instructions: "",
          instructionsTruncated: false,
        });
      }),
    );
    const onSaved = vi.fn();
    render(
      <ProjectSettingsDialog
        projectId="home"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    const open = await screen.findByRole("radio", { name: /Open web/u });
    expect((open as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Dependencies only/u }));
    const sites = screen.getByRole("textbox", { name: /Extra sites/u });
    expect((sites as HTMLTextAreaElement).value).toBe("docs.example.com");
    fireEvent.input(sites, {
      target: { value: "docs.example.com\n*.example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(posts[0]).toMatchObject({
      network: {
        preset: "dependencies",
        allow: ["docs.example.com", "*.example.org"],
      },
    });

    cleanup();
    reject = true;
    render(
      <ProjectSettingsDialog
        projectId="home"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(await screen.findByRole("radio", { name: /^Off/u }));
    expect(screen.queryByRole("textbox", { name: /Extra sites/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Check the extra sites.");
    expect(alert.textContent).toContain("is not a host name");
  });
});
