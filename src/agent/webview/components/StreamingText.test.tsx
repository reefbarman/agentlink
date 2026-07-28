/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

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

describe("StreamingText file links", () => {
  it("linkifies bare file paths in plain text", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text="The bug is in src/agent/webview/App.tsx:42 as expected."
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".file-path-link",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 42);
  });

  it("opens markdown links with relative file targets", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text="See [App.tsx](src/agent/webview/App.tsx) for details."
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".markdown-body a",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("App.tsx");
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith(
      "src/agent/webview/App.tsx",
      undefined,
    );
  });

  it("opens markdown links with #L line fragments at the referenced line", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text="See [App.tsx:42](src/agent/webview/App.tsx#L42) for details."
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".markdown-body a",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 42);
  });

  it("opens markdown links with :line suffixes at the referenced line", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text="See [App.tsx](src/agent/webview/App.tsx:42) for details."
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".markdown-body a",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 42);
  });

  it("opens markdown links whose label is a code span", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text="See [`App.tsx`](src/agent/webview/App.tsx) for details."
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".markdown-body a",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith(
      "src/agent/webview/App.tsx",
      undefined,
    );
  });

  it("linkifies inline code spans that are file paths", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text={"The bug is in `src/agent/webview/App.tsx:42` as expected."}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".file-path-link",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 42);
  });

  it("does not linkify code spans that are not file paths", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text={"Run `npm install` to fetch dependencies."}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    expect(container.querySelector(".file-path-link")).toBeNull();
  });

  it("does not linkify inside fenced code blocks", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text={"```\nimport x from 'src/agent/webview/App.tsx'\n```"}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    expect(container.querySelector(".file-path-link")).toBeNull();
  });

  it("keeps external http(s) links as real anchors and never routes them to onOpenFile", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text="Docs at [example](https://example.com/docs)."
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".markdown-body a[href]",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    fireEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("strips javascript: hrefs entirely", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <StreamingText
        text={'Click <a href="javascript:alert(1)">here</a> now.'}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const links = container.querySelectorAll("a[href]");
    for (const link of Array.from(links)) {
      expect(link.getAttribute("href") ?? "").not.toContain("javascript:");
    }
  });
});
