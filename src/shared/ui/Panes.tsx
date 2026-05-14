import type { ComponentChildren } from "preact";

interface PaneCardProps {
  children: ComponentChildren;
  className?: string;
  fill?: boolean;
}

interface PaneHeaderProps {
  title: string;
  right?: ComponentChildren;
  className?: string;
}

interface EmptyStateProps {
  children: ComponentChildren;
  className?: string;
}

export function PaneCard({ children, className, fill = false }: PaneCardProps) {
  return (
    <div
      class={`pane-card${fill ? " pane-fill" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

export function PaneHeader({ title, right, className }: PaneHeaderProps) {
  return (
    <div class={`pane-header${className ? ` ${className}` : ""}`}>
      <span>{title}</span>
      {right && <div class="pane-header-right">{right}</div>}
    </div>
  );
}

export function EmptyState({ children, className }: EmptyStateProps) {
  return (
    <div class={`empty-state${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
