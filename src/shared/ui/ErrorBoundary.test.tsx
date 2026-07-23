// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders diagnostic details and retries with a remounted child", () => {
    let renderCount = 0;
    function UnstableChild() {
      renderCount += 1;
      if (renderCount === 1) throw new Error("render exploded");
      return <div>Recovered child</div>;
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary title="Browser gateway render error">
        <UnstableChild />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Browser gateway render error",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Browser gateway render error",
    );
    expect(document.querySelector("pre")?.textContent).toContain(
      "render exploded",
    );
    expect(renderCount).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByText("Recovered child")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(renderCount).toBe(2);
  });

  it("uses the supplied reload action", () => {
    const onReload = vi.fn();
    function BrokenChild(): never {
      throw "non-error failure";
    }

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary onReload={onReload}>
        <BrokenChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("non-error failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
