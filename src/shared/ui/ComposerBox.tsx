import type { ComponentChildren } from "preact";

interface ComposerBoxProps {
  children: ComponentChildren;
  className?: string;
  accessory?: ComponentChildren;
  mainAlign?: "center" | "end";
}

export function ComposerBox({
  children,
  className,
  accessory,
  mainAlign = "center",
}: ComposerBoxProps) {
  return (
    <div class={`composer-box${className ? ` ${className}` : ""}`}>
      {accessory != null && (
        <div class="composer-box-accessory">{accessory}</div>
      )}
      <div class={`composer-box-main composer-box-main-${mainAlign}`}>
        {children}
      </div>
    </div>
  );
}
