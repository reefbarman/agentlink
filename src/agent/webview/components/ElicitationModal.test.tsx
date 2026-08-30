// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ElicitationModal } from "./ElicitationModal";
import type { McpFormElicitationRequest } from "@agentlink/protocol/mcp-elicitation";

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
      title: "Dry run",
      required: false,
      default: false,
    },
  ],
};

afterEach(cleanup);

describe("ElicitationModal", () => {
  it("keeps invalid fields visible and submits coerced shared form values", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ElicitationModal
        request={request}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect((screen.getByLabelText("Dry run") as HTMLInputElement).checked).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBe(2);
    expect(screen.getByLabelText("Environment*")).toBeTruthy();

    fireEvent.input(screen.getByLabelText("Environment*"), {
      target: { value: "prod" },
    });
    fireEvent.input(screen.getByLabelText("Replicas*"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledWith("request-1", {
      environment: "prod",
      replicas: 2,
      dryRun: false,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports cancellation without unmounting itself", () => {
    const onCancel = vi.fn();
    render(
      <ElicitationModal
        request={request}
        onSubmit={() => undefined}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledWith("request-1");
    expect(screen.getByText("Provide deployment settings.")).toBeTruthy();
  });
});
