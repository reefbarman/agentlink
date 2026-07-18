import {
  ToolbarControlButton,
  ToolbarSelector,
} from "../../../shared/ui/ToolbarSelector";
import { useEffect, useRef, useState } from "preact/hooks";

import type { ProjectInfo } from "../types";

interface ProjectSelectorProps {
  currentProjectId?: string | null;
  projects: ProjectInfo[];
  onSelect: (projectId: string) => void;
}

export function ProjectSelector({
  currentProjectId,
  projects,
  onSelect,
}: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current =
    projects.find((project) => project.projectId === currentProjectId) ??
    projects[0];

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (project: ProjectInfo) => {
    if (project.availability !== "available") return;
    setOpen(false);
    if (project.projectId !== currentProjectId) onSelect(project.projectId);
  };

  if (projects.length <= 1 || !current) return null;

  return (
    <ToolbarSelector
      containerRef={ref}
      open={open}
      className="project-selector"
      trigger={
        <ToolbarControlButton
          onClick={() => setOpen((value) => !value)}
          title={`Project: ${current.displayName}`}
          type="button"
          className={
            current.availability === "available" ? "" : "project-unavailable"
          }
        >
          <i
            class={`codicon codicon-${current.availability === "available" ? "root-folder" : "warning"}`}
          />
          <span>{current.displayName}</span>
          <i
            class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
          />
        </ToolbarControlButton>
      }
    >
      {projects.map((project) => {
        const available = project.availability === "available";
        return (
          <button
            key={project.projectId}
            class={`toolbar-selector-option${project.projectId === currentProjectId ? " active" : ""}${available ? "" : " disabled"}`}
            disabled={!available}
            onClick={() => handleSelect(project)}
            title={
              available
                ? `Start a new chat in ${project.displayName}`
                : "Project unavailable"
            }
            type="button"
          >
            <i
              class={`codicon codicon-${available ? "root-folder" : "warning"}`}
            />
            <span>{project.displayName}</span>
            {!available && (
              <span class="project-selector-status">Unavailable</span>
            )}
            {project.projectId === currentProjectId && (
              <i class="codicon codicon-check toolbar-selector-check" />
            )}
          </button>
        );
      })}
    </ToolbarSelector>
  );
}
