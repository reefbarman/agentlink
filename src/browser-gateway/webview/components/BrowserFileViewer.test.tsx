// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

const editor = {
  setModel: vi.fn(),
  revealLineInCenter: vi.fn(),
  setSelection: vi.fn(),
  dispose: vi.fn(),
};
const model = {
  getLineCount: () => 3,
  getLineMaxColumn: () => 7,
  dispose: vi.fn(),
};
const monaco = {
  editor: {
    create: vi.fn(() => editor),
    createModel: vi.fn(() => model),
  },
};
vi.mock("./browserMonacoLoader", () => ({
  configureMonacoWorkers: vi.fn(),
  defineTheme: vi.fn(),
  inferLanguageId: (path: string) =>
    path.endsWith(".md") ? "markdown" : "plaintext",
  loadMonaco: vi.fn(async () => monaco),
}));

const { BrowserFileViewer } = await import("./BrowserFileViewer");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("BrowserFileViewer", () => {
  it("loads the project file read-only and reveals the linked line", async () => {
    const fetchMock = stubFetch(200, {
      projectId: "home",
      path: "docs/notes.md",
      size: 20,
      content: "one\ntwo\nthree",
      truncated: false,
    });
    const onClose = vi.fn();
    render(
      <BrowserFileViewer
        path="/srv/agentlink/projects/home/docs/notes.md"
        line={9}
        onClose={onClose}
      />,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ask-agent/project-file?path=%2Fsrv%2Fagentlink%2Fprojects%2Fhome%2Fdocs%2Fnotes.md",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    await waitFor(() => expect(editor.setModel).toHaveBeenCalledWith(model));
    expect(monaco.editor.createModel).toHaveBeenCalledWith(
      "one\ntwo\nthree",
      "markdown",
    );
    expect(monaco.editor.create).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ readOnly: true, domReadOnly: true }),
    );
    // Lines past the end clamp to the last line.
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(3);
    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when only the start of a large file is shown", async () => {
    stubFetch(200, {
      path: "big.log",
      size: 3 * 1024 * 1024,
      content: "x".repeat(1024 * 1024),
      truncated: true,
    });
    render(<BrowserFileViewer path="big.log" onClose={() => undefined} />);
    expect(
      await screen.findByText("Showing the first 1.0 MB of 3.0 MB."),
    ).toBeTruthy();
  });

  it("explains files it cannot show without loading the editor", async () => {
    stubFetch(403, { error: "outside_project" });
    render(<BrowserFileViewer path="../secret" onClose={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This file is outside the current project.",
    );
    expect(monaco.editor.create).not.toHaveBeenCalled();
  });
});
