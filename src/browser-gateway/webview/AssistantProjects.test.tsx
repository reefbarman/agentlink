import {
  AssistantProjectSwitcher,
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
