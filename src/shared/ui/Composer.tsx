import type { ComponentChildren } from "preact";

interface FieldStackProps {
  label: ComponentChildren;
  children: ComponentChildren;
  className?: string;
  grow?: boolean;
  compact?: boolean;
}

interface ActionRowProps {
  children: ComponentChildren;
  className?: string;
}

interface StatusRowProps {
  children: ComponentChildren;
  className?: string;
}

/**
 * Labeled vertical field layout.
 * Keep this wrapped around a single primary form control so the label semantics remain clear.
 */
export function FieldStack({
  label,
  children,
  className,
  grow = false,
  compact = false,
}: FieldStackProps) {
  return (
    <label
      class={`field-stack${compact ? " compact-field" : ""}${grow ? " grow-field" : ""}${className ? ` ${className}` : ""}`}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ActionRow({ children, className }: ActionRowProps) {
  return (
    <div class={`toolbar-actions${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

export function StatusRow({ children, className }: StatusRowProps) {
  return (
    <div class={`toolbar-status-row${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
