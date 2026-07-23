import embed, { type VisualizationSpec } from "vega-embed";

export async function renderVega(
  source: string,
  mode: "vega" | "vega-lite",
): Promise<string> {
  const spec = JSON.parse(source) as VisualizationSpec;
  const container = document.createElement("div");
  await embed(container, spec, {
    actions: false,
    renderer: "svg",
    mode,
    theme: "dark",
  });
  return container.innerHTML;
}
