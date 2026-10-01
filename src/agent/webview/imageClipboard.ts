// Transcript images are `data:` URLs. The webview CSP has no `connect-src`, so
// decode them directly instead of using `fetch`. Chromium's async clipboard only
// accepts `image/png`, so other formats are re-encoded through a canvas.

export function canCopyImageToClipboard(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

function dataUrlToBlob(src: string): Blob {
  const match = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(src);
  if (!match) throw new Error("Unsupported image source");
  const [, mimeType = "application/octet-stream", , base64, payload] = match;
  if (!base64)
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image failed to load"));
    image.src = src;
  });
}

async function toPngBlob(src: string): Promise<Blob> {
  if (src.startsWith("data:")) {
    const blob = dataUrlToBlob(src);
    if (blob.type === "image/png") return blob;
  }
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Image encoding failed")),
      "image/png",
    );
  });
}

export async function copyImageToClipboard(src: string): Promise<void> {
  // Pass a promise so the clipboard write starts within the click's user
  // activation even when PNG conversion is asynchronous.
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": toPngBlob(src) }),
  ]);
}
