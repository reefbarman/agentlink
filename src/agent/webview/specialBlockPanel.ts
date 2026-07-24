// Entry point for the pop-out special block preview panel (Mermaid/Vega).
// Bundled to dist/special-block-panel.js so the panel works from the packaged
// .vsix — importing raw node_modules files fails there (they are not shipped),
// and vega-embed's dist uses bare specifiers a browser can't resolve anyway.
import { renderMermaid } from "./components/mermaidRenderer";
import { renderVega } from "./components/vegaRenderer";

type SpecialBlockKind = "mermaid" | "vega" | "vega-lite";

interface SpecialBlockPayload {
  kind: SpecialBlockKind;
  source: string;
}

function readPayload(): SpecialBlockPayload | undefined {
  const dataEl = document.getElementById("special-block-data");
  if (!dataEl?.textContent) return undefined;
  try {
    const parsed = JSON.parse(dataEl.textContent) as {
      kind?: unknown;
      source?: unknown;
    };
    if (
      (parsed.kind === "mermaid" ||
        parsed.kind === "vega" ||
        parsed.kind === "vega-lite") &&
      typeof parsed.source === "string"
    ) {
      return { kind: parsed.kind, source: parsed.source };
    }
  } catch {
    // Fall through to the error state below.
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function render(): Promise<void> {
  const target = document.getElementById("diagram");
  if (!target) return;

  const payload = readPayload();
  if (!payload) {
    target.innerHTML = '<div class="error">Failed to load preview data.</div>';
    return;
  }

  try {
    target.innerHTML =
      payload.kind === "mermaid"
        ? await renderMermaid(
            payload.source,
            `special-block-panel-${Date.now()}`,
          )
        : await renderVega(payload.source, payload.kind);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    target.innerHTML = `<div class="error">Failed to render preview: ${escapeHtml(message)}</div>`;
  }
}

void render();
