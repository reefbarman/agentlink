import type { ComponentChildren } from "preact";

interface TitleRowProps {
  title: ComponentChildren;
  right?: ComponentChildren;
  className?: string;
}

interface PillProps {
  children: ComponentChildren;
  subtle?: boolean;
  className?: string;
}

interface MetaGridProps {
  children: ComponentChildren;
  compact?: boolean;
  className?: string;
}

interface MetaItemProps {
  label: ComponentChildren;
  value: ComponentChildren;
}

interface DetailBlockProps {
  label: ComponentChildren;
  children: ComponentChildren;
  className?: string;
}

export function TitleRow({ title, right, className }: TitleRowProps) {
  return (
    <div class={`review-title-row${className ? ` ${className}` : ""}`}>
      <div class="review-title">{title}</div>
      {right}
    </div>
  );
}

export function Pill({ children, subtle = false, className }: PillProps) {
  return (
    <span
      class={`review-pill${subtle ? " subtle" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}

export function MetaGrid({
  children,
  compact = false,
  className,
}: MetaGridProps) {
  return (
    <div
      class={`review-meta-grid${compact ? " compact-grid" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

export function MetaItem({ label, value }: MetaItemProps) {
  return (
    <div>
      <span class="review-meta-label">{label}</span>
      <div class="review-meta-value">{value}</div>
    </div>
  );
}

export function DetailBlock({ label, children, className }: DetailBlockProps) {
  return (
    <div class={`review-detail-block${className ? ` ${className}` : ""}`}>
      <div class="review-meta-label">{label}</div>
      <div>{children}</div>
    </div>
  );
}
