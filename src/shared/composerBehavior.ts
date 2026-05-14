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
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function focusAndAutosizeTextarea(
  textarea: HTMLTextAreaElement | null | undefined,
): void {
  if (!textarea) return;
  textarea.focus();
  autosizeTextarea(textarea);
}
