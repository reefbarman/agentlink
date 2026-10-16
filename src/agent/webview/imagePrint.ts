// Prints a single transcript image through a throwaway same-origin iframe so
// the page chrome (transcript, composer, lightbox) never reaches the printout.
// VS Code webviews run in a sandboxed iframe without `allow-modals`, which
// silently blocks `print()`, so printing is only offered on the browser and
// Desktop surfaces.

const PRINT_CLEANUP_FALLBACK_MS = 5 * 60_000;

export function canPrintImage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.print === "function" &&
    typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi !==
      "function"
  );
}

export function printImage(src: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(frame);

    let fallback: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(fallback);
      frame.remove();
    };

    const printWindow = frame.contentWindow;
    const printDocument = frame.contentDocument;
    if (!printWindow || !printDocument) {
      cleanup();
      reject(new Error("Print frame is unavailable"));
      return;
    }

    printDocument.title = title;
    const style = printDocument.createElement("style");
    style.textContent = [
      "@page { margin: 12mm; }",
      "html, body { margin: 0; height: 100%; }",
      "body { display: flex; align-items: center; justify-content: center; }",
      "img { display: block; max-width: 100%; max-height: 100vh; object-fit: contain; }",
    ].join("\n");
    printDocument.head.appendChild(style);

    const image = printDocument.createElement("img");
    image.alt = title;
    image.onerror = () => {
      cleanup();
      reject(new Error("Image failed to load"));
    };
    image.onload = () => {
      // Chromium's print() may return before the dialog closes; keep the
      // frame alive until printing finishes so the job is not cancelled.
      printWindow.addEventListener("afterprint", cleanup, { once: true });
      fallback = setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);
      try {
        printWindow.focus();
        printWindow.print();
        resolve();
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    printDocument.body.appendChild(image);
    image.src = src;
  });
}
