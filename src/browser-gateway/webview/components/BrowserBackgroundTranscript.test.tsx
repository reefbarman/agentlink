import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { BrowserBackgroundTranscript } from "./BrowserBackgroundTranscript";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";

const messages: ChatMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    content: "",
    timestamp: 1,
    blocks: [
      {
        type: "tool_call",
        id: "command-1",
        name: "execute_command",
        inputJson: JSON.stringify({
          command: "npm test",
          reason: "Verify browser transcript parity.",
        }),
        result: JSON.stringify({ exit_code: 0 }),
        complete: true,
      },
      {
        type: "tool_call",
        id: "read-1",
        name: "read_file",
        inputJson: JSON.stringify({ path: "src/index.ts" }),
        result: "src/index.ts:12",
        resultImages: [{ mimeType: "image/png", data: "YWJjZA==" }],
        complete: true,
      },
    ],
  },
];

function renderTranscript(workspaceActionsEnabled: boolean) {
  const callbacks = {
    onOpenFile: vi.fn(),
    onOpenImageInEditor: vi.fn(),
    onRetry: vi.fn(),
    onSignIn: vi.fn(),
    onSignInAnotherAccount: vi.fn(),
    onStopBackground: vi.fn(),
    onOpenTranscript: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <BrowserBackgroundTranscript
      task="Audit browser parity"
      sessionId="background-1"
      messages={messages}
      streaming={false}
      sessions={[]}
      workspaceActionsEnabled={workspaceActionsEnabled}
      {...callbacks}
    />,
  );
  return callbacks;
}

afterEach(cleanup);

describe("BrowserBackgroundTranscript", () => {
  it("renders shared command metadata and forwards workspace display actions", () => {
    const callbacks = renderTranscript(true);

    fireEvent.click(screen.getByRole("button", { name: /^Tools / }));
    expect(screen.getByText("Reason")).toBeTruthy();
    expect(screen.getByText("Verify browser transcript parity.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));
    const fileLink = screen.getAllByRole("link", {
      name: "src/index.ts:12",
    })[0];
    expect(fileLink).toBeTruthy();
    fireEvent.click(fileLink!);
    expect(callbacks.onOpenFile).toHaveBeenCalledWith("src/index.ts", 12);

    fireEvent.click(
      screen.getByRole("button", { name: "Open read_file result image 1" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open image in editor" }),
    );
    expect(callbacks.onOpenImageInEditor).toHaveBeenCalledWith({
      src: "data:image/png;base64,YWJjZA==",
      mimeType: "image/png",
    });
  });

  it("does not expose VS Code-hosted actions for Browser Ask Agent", () => {
    const callbacks = renderTranscript(false);

    fireEvent.click(screen.getByRole("button", { name: /^Tools / }));
    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));
    expect(screen.queryByRole("link", { name: "src/index.ts:12" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open read_file result image 1" }),
    );
    expect(
      screen.queryByRole("button", { name: "Open image in editor" }),
    ).toBeNull();
    expect(callbacks.onOpenFile).not.toHaveBeenCalled();
    expect(callbacks.onOpenImageInEditor).not.toHaveBeenCalled();
  });
});
