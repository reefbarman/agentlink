/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";

import type { TodoItem } from "@agentlink/protocol/chat-transcript";
import { TodoPanel } from "./TodoPanel";

function makeTodos(activeIndex: number): TodoItem[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `task-${index + 1}`,
    content: `Task ${index + 1}`,
    activeForm: `Doing task ${index + 1}`,
    status: index === activeIndex ? "in_progress" : "pending",
  }));
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    top,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => undefined,
  };
}

describe("TodoPanel", () => {
  afterEach(cleanup);

  it("centers a newly active task without overriding later manual scrolling", () => {
    const { container, rerender } = render(<TodoPanel todos={makeTodos(0)} />);
    const body = container.querySelector(".todo-panel-body") as HTMLDivElement;

    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 144 },
      scrollHeight: { configurable: true, value: 320 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    body.getBoundingClientRect = () => rect(100, 144);

    const taskEight = screen.getByText("Task 8");
    taskEight.getBoundingClientRect = () => rect(290 - body.scrollTop, 18);

    rerender(<TodoPanel todos={makeTodos(7)} />);

    expect(body.scrollTop).toBe(127);

    body.scrollTop = 20;
    rerender(<TodoPanel todos={makeTodos(7)} />);

    expect(body.scrollTop).toBe(20);
  });
});
