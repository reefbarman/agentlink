import { useLayoutEffect, useRef } from "preact/hooks";

interface RulePatternInputProps {
  value: string;
  disabled?: boolean;
  /** Dim the field while its rule is not going to be saved. */
  dimmed?: boolean;
  ariaLabel?: string;
  onChange: (value: string) => void;
}

/**
 * Single-value rule pattern field that wraps instead of scrolling sideways, so
 * a long path or command stays fully visible and editable in a narrow panel.
 */
export function RulePatternInput({
  value,
  disabled,
  dimmed,
  ariaLabel = "Rule pattern",
  onChange,
}: RulePatternInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      // Nothing to measure while hidden; let CSS size the field instead.
      if (element.scrollHeight === 0) {
        element.style.height = "";
        return;
      }
      const borders = element.offsetHeight - element.clientHeight;
      element.style.height = `${element.scrollHeight + borders}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      spellcheck={false}
      aria-label={ariaLabel}
      class={`text-input rule-pattern-input ${dimmed ? "skipped" : ""}`}
      value={value}
      disabled={disabled}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
      onInput={(event) => {
        const target = event.target as HTMLTextAreaElement;
        const singleLine = target.value.replace(/[\r\n]+/g, "");
        if (singleLine !== target.value) target.value = singleLine;
        onChange(singleLine);
      }}
    />
  );
}
