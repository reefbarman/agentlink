import type { ComponentChildren } from "preact";
import { forwardRef } from "preact/compat";

interface ComposerBoxProps {
  children: ComponentChildren;
  className?: string;
  accessory?: ComponentChildren;
  mainAlign?: "center" | "end";
}

export const ComposerBox = forwardRef<HTMLDivElement, ComposerBoxProps>(
  function ComposerBox(
    { children, className, accessory, mainAlign = "center" },
    ref,
  ) {
    return (
      <div ref={ref} class={`composer-box${className ? ` ${className}` : ""}`}>
        {accessory != null && (
          <div class="composer-box-accessory">{accessory}</div>
        )}
        <div class={`composer-box-main composer-box-main-${mainAlign}`}>
          {children}
        </div>
      </div>
    );
  },
);
