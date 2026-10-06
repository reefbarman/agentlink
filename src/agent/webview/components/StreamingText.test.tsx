/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import {
  resetFileLinkFeedbackForTests,
  showFileOpenFailure,
} from "./fileLinkFeedback";

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
  vi.restoreAllMocks();
});

describe("StreamingText provider citations", () => {
  const marker = "\uE200cite\uE202turn0search0\uE201";

  it("hides unresolved citation groups without removing surrounding text or links", () => {
    const { container } = render(
      <StreamingText
        text={`Before ${marker} and \uE200cite\uE202turn0search1\uE202turn0search2\uE201 after. [Apple](https://apple.com)`}
        streaming={false}
      />,
    );
    expect(container.textContent?.trim()).toBe("Before  and  after. Apple");
    expect(
      screen.getByRole("link", { name: "Apple" }).getAttribute("href"),
    ).toBe("https://apple.com");
  });

  it.each([
    "\uE200",
    "\uE200c",
    "\uE200ci",
    "\uE200cit",
    "\uE200cite",
    "\uE200cite\uE202",
    "\uE200cite\uE202turn0search",
  ])("hides a citation prefix while streaming: %j", (prefix) => {
    const text = `${"Text ".repeat(250)}${prefix}`;
    const { container } = render(
      <StreamingText text={text} streaming={true} />,
    );
    expect(container.textContent).not.toContain("\uE200");
    expect(container.textContent).not.toContain("turn0search");
  });

  it("preserves literal citation syntax in inline and fenced code", () => {
    const { container } = render(
      <StreamingText
        text={`\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\``}
        streaming={false}
      />,
    );
    expect(
      Array.from(
        container.querySelectorAll("code"),
        (code) => code.textContent,
      ),
    ).toEqual([marker, marker]);
  });

  it("renders explicitly mapped safe sources and escapes their titles", () => {
    const { container } = render(
      <StreamingText
        text={`Supported. ${marker}`}
        streaming={false}
        citations={[
          {
            url: "https://apple.com/support",
            title: 'Apple "support" <img src=x onerror=alert(1)>',
            citedText: marker,
          },
          { url: "https://apple.com/support", citedText: marker },
          { url: "javascript:alert(1)", citedText: marker },
          {
            url: "https://unrelated.example.com",
            citedText: "An unrelated passage",
          },
        ]}
      />,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://apple.com/support");
    expect(links[0]?.getAttribute("title")).toBe(
      'Apple "support" <img src=x onerror=alert(1)>',
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent?.trim()).toBe("Supported. [source]");
  });
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
    const error = new Error("chunk unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    rendererMocks.renderMermaid.mockRejectedValue(error);
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
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      "[mermaid] Failed to render diagram 0:",
      error,
    );
  });
});

describe("StreamingText mid-stream mounts", () => {
  it("immediately reveals text that predates mount instead of replaying it", () => {
    const longText = `${"lorem ipsum ".repeat(150)}END-MARKER`;
    const onRevealStart = vi.fn();
    const { container } = render(
      <StreamingText
        text={longText}
        streaming={true}
        onRevealStart={onRevealStart}
      />,
    );

    expect(onRevealStart).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("END-MARKER");
  });

  it("keeps buffering when mounted near the start of a live stream", () => {
    const onRevealStart = vi.fn();
    const { container } = render(
      <StreamingText
        text="A short first chunk."
        streaming={true}
        onRevealStart={onRevealStart}
      />,
    );

    expect(onRevealStart).not.toHaveBeenCalled();
    expect(container.textContent ?? "").not.toContain("first chunk");
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
    const onExternalClick = vi.fn((event: Event) => {
      expect(event.defaultPrevented).toBe(false);
      // Browser navigation is outside this test and is not implemented by jsdom.
      event.preventDefault();
    });
    container.addEventListener("click", onExternalClick, { once: true });
    fireEvent.click(link);
    expect(onExternalClick).toHaveBeenCalledOnce();
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

describe("StreamingText file link failure feedback", () => {
  afterEach(() => {
    resetFileLinkFeedbackForTests();
  });

  it("anchors open-failure feedback to the clicked link", () => {
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
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 42);

    expect(showFileOpenFailure("src/agent/webview/App.tsx", "not_found")).toBe(
      true,
    );
    const popup = document.body.querySelector(".file-link-open-feedback");
    expect(popup?.textContent).toBe("File not found");
  });
});
