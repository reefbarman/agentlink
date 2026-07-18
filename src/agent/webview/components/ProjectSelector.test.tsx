// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ProjectSelector } from "./ProjectSelector";

const projects = [
  {
    projectId: "project-a",
    displayName: "Project A",
    availability: "available" as const,
  },
  {
    projectId: "project-b",
    displayName: "Project B",
    availability: "available" as const,
  },
  {
    projectId: "project-c",
    displayName: "Project C",
    availability: "unavailable" as const,
  },
];

afterEach(cleanup);

describe("ProjectSelector", () => {
  it("hides in a single-project workspace", () => {
    const { container } = render(
      <ProjectSelector
        currentProjectId="project-a"
        projects={[projects[0]]}
        onSelect={vi.fn()}
      />,
    );

    expect(container.textContent).toBe("");
  });

  it("starts a new project selection and disables unavailable projects", () => {
    const onSelect = vi.fn();
    render(
      <ProjectSelector
        currentProjectId="project-a"
        projects={projects}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTitle("Project: Project A"));
    fireEvent.click(screen.getByTitle("Start a new chat in Project B"));
    expect(onSelect).toHaveBeenCalledWith("project-b");

    fireEvent.click(screen.getByTitle("Project: Project A"));
    const unavailable = screen.getByTitle("Project unavailable");
    expect((unavailable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(unavailable);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
