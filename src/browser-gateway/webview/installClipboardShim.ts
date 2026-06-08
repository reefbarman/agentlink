// The browser gateway is always served over plain HTTP on a local-only origin
// (e.g. http://agentlink.local:47137). `navigator.clipboard` only exists in a
// secure context (HTTPS or localhost), so on this origin it is `undefined`.
// Monaco registers a global copy handler on document.body that calls
// `navigator.clipboard.write(...)`, and our own copy buttons call
// `navigator.clipboard.writeText(...)`. Both throw
// "Cannot read properties of undefined (reading 'write')" and spam the console.
//
// This installs a minimal, execCommand-based clipboard shim when (and only when)
// the native API is missing, so copy works and the errors disappear. It is a
// no-op in secure contexts where the real API is present.

function legacyCopyText(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Keep it out of view and out of layout flow, but still focusable/selectable.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  document.body.removeChild(textarea);

  // Restore whatever the user had selected before we hijacked the selection.
  if (previousRange && selection) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }

  return ok;
}

async function blobText(item: ClipboardItem, type: string): Promise<string> {
  const blob = await item.getType(type);
  return blob.text();
}

export function installClipboardShim(): void {
  if (typeof navigator === "undefined") return;
  // Native clipboard is available (secure context) — leave it alone.
  if (navigator.clipboard) return;

  const shim = {
    async writeText(text: string): Promise<void> {
      if (!legacyCopyText(text)) {
        throw new Error("Copy command was unsuccessful");
      }
    },
    async readText(): Promise<string> {
      // Programmatic reads are not possible without the async clipboard API.
      // Monaco's paste path falls back to the native paste event, so this only
      // needs to fail gracefully rather than throw synchronously.
      throw new Error("Clipboard read is not supported on this origin");
    },
    async write(items: ClipboardItem[]): Promise<void> {
      for (const item of items) {
        if (item.types.includes("text/plain")) {
          const text = await blobText(item, "text/plain");
          if (legacyCopyText(text)) return;
        }
      }
      throw new Error("Copy command was unsuccessful");
    },
    async read(): Promise<ClipboardItem[]> {
      throw new Error("Clipboard read is not supported on this origin");
    },
  };

  try {
    Object.defineProperty(navigator, "clipboard", {
      value: shim,
      configurable: true,
    });
  } catch {
    // Some environments make `navigator.clipboard` non-configurable. Best effort.
  }
}
