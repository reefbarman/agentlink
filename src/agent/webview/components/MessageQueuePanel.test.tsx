// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageQueuePanel, type MessageQueueItem } from "./MessageQueuePanel";

afterEach(() => cleanup());

describe("MessageQueuePanel editing", () => {
  it("prevents steer and interject actions until editing finishes", () => {
    const item: MessageQueueItem = {
      id: "queue-1",
      text: "original message",
      source: "vscode",
      interjectionReady: true,
    };
    const onSteer = vi.fn();
    const onInterject = vi.fn();
    const onEdit = vi.fn();
    const onEditingChange = vi.fn();
    const { getByRole } = render(
      <MessageQueuePanel
        queue={[item]}
        onSteer={onSteer}
        onInterject={onInterject}
        onEdit={onEdit}
        onEditingChange={onEditingChange}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Edit" }));

    expect(onEditingChange).toHaveBeenCalledWith(item, true);
    const steer = getByRole("button", {
      name: "Finish editing before steering",
    }) as HTMLButtonElement;
    const interject = getByRole("button", {
      name: "Finish editing before interjecting",
    }) as HTMLButtonElement;
    expect(steer.disabled).toBe(true);
    expect(interject.disabled).toBe(true);

    fireEvent.click(steer);
    fireEvent.click(interject);
    expect(onSteer).not.toHaveBeenCalled();
    expect(onInterject).not.toHaveBeenCalled();

    const editor = getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: "edited message" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledWith(item, "edited message");
    expect(onEditingChange).toHaveBeenLastCalledWith(item, false);
  });
});
