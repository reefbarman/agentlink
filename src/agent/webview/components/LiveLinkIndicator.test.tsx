/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { LiveLinkIndicator } from "./LiveLinkIndicator";

describe("LiveLinkIndicator", () => {
  afterEach(cleanup);

  it("renders the AgentLink mark with the selected motion class", () => {
    const { container } = render(<LiveLinkIndicator motion="moving" />);
    const indicator = container.querySelector(".live-link-indicator");

    expect(indicator?.classList.contains("live-link-moving")).toBe(true);
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll(".live-link-segment")).toHaveLength(2);
  });

  it("can name a standalone indicator", () => {
    const { getByRole } = render(
      <LiveLinkIndicator motion="attention" label="Approval needed" />,
    );

    expect(getByRole("img", { name: "Approval needed" })).toBeTruthy();
  });
});
