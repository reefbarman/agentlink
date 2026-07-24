export function canSubmitComposer(params: {
  text: string;
  hasAttachments?: boolean;
  hasMedia?: boolean;
}): boolean {
  return (
    params.text.trim().length > 0 ||
    params.hasAttachments === true ||
    params.hasMedia === true
  );
}

export function autosizeTextarea(
  textarea: HTMLTextAreaElement | null | undefined,
): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  const measured = textarea.scrollHeight;
  textarea.style.height = `${measured}px`;
  // Collapsing to "auto" can shrink the surrounding scroller below its
  // overflow threshold, hiding its scrollbar during measurement. The measured
  // height then belongs to a wider textarea than the one that renders once the
  // scrollbar returns: text rewraps taller and the last lines sit clipped
  // under overflow:hidden, unreachable by scrolling (only caret movement
  // reveals them). Re-read at the settled width and correct; this converges
  // because a taller textarea cannot change the scrollbar state again.
  const settled = textarea.scrollHeight;
  if (settled !== measured) {
    textarea.style.height = `${settled}px`;
  }
}

export function focusAndAutosizeTextarea(
  textarea: HTMLTextAreaElement | null | undefined,
): void {
  if (!textarea) return;
  textarea.focus();
  autosizeTextarea(textarea);
}

/**
 * Autosized textareas hide overflow and carry an explicit pixel height, so a
 * height measured at a different width (panel resize rewraps the text) or
 * while hidden (clientWidth 0) silently clips content that only caret
 * movement can reveal. Re-run autosize whenever the rendered width changes;
 * gating on width keeps the observer from reacting to its own height writes.
 * Returns a cleanup function that disconnects the observer.
 */
export function observeTextareaAutosize(
  textarea: HTMLTextAreaElement | null | undefined,
): (() => void) | undefined {
  if (!textarea || typeof ResizeObserver === "undefined") return undefined;
  let lastWidth = textarea.clientWidth;
  const observer = new ResizeObserver(() => {
    const width = textarea.clientWidth;
    if (width === lastWidth || width <= 0) return;
    lastWidth = width;
    autosizeTextarea(textarea);
  });
  observer.observe(textarea);
  return () => observer.disconnect();
}
