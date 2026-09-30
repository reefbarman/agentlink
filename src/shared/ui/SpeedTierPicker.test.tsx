// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import type { ChatModelInfo } from "@agentlink/protocol/chat-catalog";
import { SpeedTierPicker } from "./SpeedTierPicker";

const models: ChatModelInfo[] = [
  {
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    provider: "codex",
    contextWindow: 1_050_000,
    serviceTiers: ["fast", "ultrafast"],
    authenticated: true,
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    provider: "codex",
    contextWindow: 1_050_000,
    serviceTiers: ["fast"],
    authenticated: true,
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    provider: "codex",
    contextWindow: 1_050_000,
    authenticated: true,
  },
];

afterEach(() => {
  cleanup();
});

describe("SpeedTierPicker", () => {
  it("is hidden for models without premium tiers", () => {
    const { container } = render(
      <SpeedTierPicker
        current="standard"
        currentModel="gpt-5.4"
        models={models}
        onSelect={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("is a single on/off button when the model has one premium tier", () => {
    const onSelect = vi.fn();
    const { getByRole, rerender } = render(
      <SpeedTierPicker
        current="standard"
        currentModel="gpt-6.1-sol"
        models={models}
        onSelect={onSelect}
      />,
    );
    const button = getByRole("button");
    expect(button.textContent).toContain("Fast");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("fast");

    rerender(
      <SpeedTierPicker
        current="fast"
        currentModel="gpt-6.1-sol"
        models={models}
        onSelect={onSelect}
      />,
    );
    expect(getByRole("button").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button"));
    expect(onSelect).toHaveBeenLastCalledWith("standard");
  });

  it("treats an unsupported selection as Standard", () => {
    const { getByRole } = render(
      <SpeedTierPicker
        current="ultrafast"
        currentModel="gpt-6.1-sol"
        models={models}
        onSelect={vi.fn()}
      />,
    );
    expect(getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });

  it("offers every supported tier in a dropdown when there are several", () => {
    const onSelect = vi.fn();
    const { getByTitle, getByText } = render(
      <SpeedTierPicker
        current="standard"
        currentModel="gpt-6-astra"
        models={models}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByTitle("Speed: Standard"));
    expect(getByText("Fast")).not.toBeNull();
    fireEvent.click(getByText("Ultrafast"));
    expect(onSelect).toHaveBeenCalledWith("ultrafast");
  });
});
