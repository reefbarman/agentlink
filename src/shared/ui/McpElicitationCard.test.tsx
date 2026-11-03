// @vitest-environment jsdom

import {
  McpFormElicitationCard,
  McpUrlElicitationCard,
} from "./McpElicitationCard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { McpFormElicitationRequest } from "@agentlink/protocol/mcp-elicitation";
import type { McpUrlElicitationRequest } from "@agentlink/protocol/mcp-url-elicitation";

const request: McpFormElicitationRequest = {
  id: "request-1",
  serverName: "example-server",
  message: "Provide deployment settings.",
  fields: [
    {
      kind: "string",
      name: "environment",
      title: "Environment",
      required: true,
      minLength: 3,
    },
    {
      kind: "number",
      name: "replicas",
      title: "Replicas",
      required: true,
      minimum: 1,
    },
    {
      kind: "boolean",
      name: "dryRun",
      required: false,
      default: false,
    },
  ],
};

const urlRequest: McpUrlElicitationRequest = {
  id: "url-1",
  serverName: "auth-server",
  message: "Sign in to continue.",
  url: "https://example.com/login?state=abc",
  elicitationId: "e-1",
  origin: "https://example.com",
  host: "example.com",
  isLocalAddress: false,
};

afterEach(cleanup);

describe("McpFormElicitationCard", () => {
  it("keeps invalid fields visible and submits coerced values", async () => {
    const onRespond = vi.fn();
    render(<McpFormElicitationCard request={request} onRespond={onRespond} />);

    // Untitled field names are humanized rather than shown raw.
    const dryRun = screen.getByLabelText(/Dry run/) as HTMLInputElement;
    expect(dryRun.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBe(3);

    fireEvent.input(screen.getByLabelText(/Environment/), {
      target: { value: "prod" },
    });
    fireEvent.input(screen.getByLabelText(/Replicas/), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onRespond).toHaveBeenCalledWith({
      id: "request-1",
      action: "accept",
      values: { environment: "prod", replicas: 2, dryRun: false },
    });
  });

  it("sends decline and cancel as distinct actions", () => {
    const onRespond = vi.fn();
    render(<McpFormElicitationCard request={request} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRespond.mock.calls.map(([response]) => response)).toEqual([
      { id: "request-1", action: "decline" },
      { id: "request-1", action: "cancel" },
    ]);
    expect(screen.getByText("Provide deployment settings.")).toBeTruthy();
  });

  it("shows a remote submission error", async () => {
    const onRespond = vi.fn(async () => ({
      ok: false,
      error: "This request is no longer active.",
    }));
    render(<McpFormElicitationCard request={request} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(
      await screen.findByText("This request is no longer active."),
    ).toBeTruthy();
  });
});

describe("McpUrlElicitationCard", () => {
  it("shows the full URL and maps each button to its action", () => {
    const onRespond = vi.fn();
    render(
      <McpUrlElicitationCard request={urlRequest} onRespond={onRespond} />,
    );

    expect(screen.getByText(urlRequest.url)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open page" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRespond.mock.calls).toEqual([
      ["url-1", "accept"],
      ["url-1", "decline"],
      ["url-1", "cancel"],
    ]);
  });

  it("disables Open when the host cannot open external windows", () => {
    render(
      <McpUrlElicitationCard
        request={{ ...urlRequest, isLocalAddress: true }}
        onRespond={() => undefined}
        externalBrowserUnavailable
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Open page" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/local or private network address/)).toBeTruthy();
  });
});
