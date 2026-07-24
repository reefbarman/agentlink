/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/preact";

import { StreamingText } from "./StreamingText";

const rendererMocks = vi.hoisted(() => ({
  renderMermaid: vi.fn(),
  renderVega: vi.fn(),
}));

vi.mock("./mermaidRenderer", () => ({
  renderMermaid: rendererMocks.renderMermaid,
}));

vi.mock("./vegaRenderer", () => ({
  renderVega: rendererMocks.renderVega,
}));

afterEach(() => {
  cleanup();
  rendererMocks.renderMermaid.mockReset();
  rendererMocks.renderVega.mockReset();
});

describe("StreamingText lazy special-block renderers", () => {
  it("renders ordinary Markdown without invoking a heavy renderer", () => {
    render(<StreamingText text="Hello **world**." streaming={false} />);

    expect(screen.getByText("world")).toBeTruthy();
    expect(rendererMocks.renderMermaid).not.toHaveBeenCalled();
    expect(rendererMocks.renderVega).not.toHaveBeenCalled();
  });

  it("adds a restrained source icon to external web links only", () => {
    render(
      <StreamingText
        text={
          "[AgentLink docs](https://example.com/docs) and [VS Code action](vscode://agentlink.open)"
        }
        streaming={false}
      />,
    );

    const webLink = screen.getByText("AgentLink docs").closest("a");
    const vscodeLink = screen.getByText("VS Code action").closest("a");
    expect(
      webLink?.querySelector(
        ".external-link-flourish.codicon.codicon-globe[aria-hidden='true']",
      ),
    ).toBeTruthy();
    expect(vscodeLink?.querySelector(".external-link-flourish")).toBeNull();
  });

  it("loads only the Mermaid renderer for a Mermaid fence", async () => {
    rendererMocks.renderMermaid.mockResolvedValue("<svg>diagram</svg>");
    render(
      <StreamingText
        text={"```mermaid\ngraph TD\nA --> B\n```"}
        streaming={false}
      />,
    );

    await waitFor(() => {
      expect(rendererMocks.renderMermaid).toHaveBeenCalledWith(
        "graph TD\nA --> B",
        expect.stringMatching(/^mermaid-/),
      );
      expect(document.querySelector(".mermaid-render svg")?.textContent).toBe(
        "diagram",
      );
    });
    expect(rendererMocks.renderVega).not.toHaveBeenCalled();
  });

  it("loads only the Vega renderer for a Vega-Lite fence", async () => {
    rendererMocks.renderVega.mockResolvedValue("<svg>chart</svg>");
    const source = '{"mark":"bar","data":{"values":[]}}';
    render(
      <StreamingText
        text={`\`\`\`vega-lite\n${source}\n\`\`\``}
        streaming={false}
      />,
    );

    await waitFor(() => {
      expect(rendererMocks.renderVega).toHaveBeenCalledWith(
        source,
        "vega-lite",
      );
      expect(document.querySelector(".vega-render svg")?.textContent).toBe(
        "chart",
      );
    });
    expect(rendererMocks.renderMermaid).not.toHaveBeenCalled();
  });

  it("keeps renderer failures localized to the special block", async () => {
    rendererMocks.renderMermaid.mockRejectedValue(
      new Error("chunk unavailable"),
    );
    render(
      <StreamingText
        text={"Before\n\n```mermaid\ngraph TD\nA --> B\n```\n\nAfter"}
        streaming={false}
      />,
    );

    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByText("Failed to render diagram: chunk unavailable"),
      ).toBeTruthy();
    });
  });
});
