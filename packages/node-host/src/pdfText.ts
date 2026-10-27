// unpdf's bundled PDF.js runs a startup polyfill that does
// `globalThis.navigator ??= {}` (then sets `.platform` / `.userAgent`). In some
// hosts (e.g. VS Code's Electron Node runtime, Node 21+) `globalThis.navigator`
// is defined as a getter-only property that resolves to a nullish value, so the
// `??=` triggers a write that throws "Cannot set property navigator ... which
// has only a getter". That surfaces to us as unpdf's "Serverless PDF.js bundle
// could not be resolved" error. Pre-installing a writable navigator object
// avoids the failing assignment without disturbing real Navigator instances.
function ensurePdfNavigatorShim(): void {
  try {
    let current: unknown;
    try {
      current = (globalThis as { navigator?: unknown }).navigator;
    } catch {
      current = undefined;
    }
    if (current != null) return; // real navigator present; polyfill short-circuits
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "", userAgent: "" },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // If navigator can't be redefined we fall through; the import may still
    // succeed on hosts where the property is already writable.
  }
}

// PDF.js refuses to run if `Object.prototype` or `Array.prototype` have any
// enumerable properties — its worker does `for (const k in {})` / `for (const k
// in [])` and throws "The `Array.prototype` contains unexpected enumerable
// property ...". The VS Code extension host shares a single global prototype
// chain across all extensions, and some of them pollute it (e.g. a legacy
// `Array.prototype.move`). We can't control who added it, so before loading
// PDF.js we make any such properties non-enumerable. This preserves the
// method's behavior (it stays callable) and only hides it from `for...in`,
// which is the correct state for a prototype method anyway.
function deEnumeratePrototypePollution(): void {
  for (const proto of [Object.prototype, Array.prototype]) {
    let keys: string[];
    try {
      keys = Object.keys(proto); // own enumerable string-keyed properties
    } catch {
      continue;
    }
    for (const key of keys) {
      try {
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc || !desc.enumerable || !desc.configurable) continue;
        Object.defineProperty(proto, key, { ...desc, enumerable: false });
      } catch {
        // Non-configurable or otherwise unmodifiable — skip; PDF.js may still
        // throw, but there is nothing safe we can do about it here.
      }
    }
  }
}

/** Extract a PDF's text with pages merged, as VS Code's `read_file` does. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  ensurePdfNavigatorShim();
  deEnumeratePrototypePollution();
  // Lazy-import unpdf so the PDF.js runtime is only loaded when a PDF is
  // actually read, never at startup. unpdf is a serverless build of PDF.js
  // with no native canvas / worker dependencies, so it survives single-file
  // esbuild bundles (unlike pdf-parse, whose @napi-rs/canvas + pdf.worker
  // file loads break under bundling and crashed VS Code activation).
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
