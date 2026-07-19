// @vitest-environment jsdom

import type {
  McpElicitationField,
  McpElicitationValues,
} from "../mcpElicitation.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { McpElicitationFormControls } from "./McpElicitationFormControls.js";

const fields: McpElicitationField[] = [
  {
    kind: "string",
    name: "email",
    title: "Email address",
    description: "Used for notifications",
    required: true,
    format: "email",
    minLength: 5,
    maxLength: 100,
  },
  {
    kind: "string",
    name: "callback",
    required: false,
    format: "uri",
  },
  {
    kind: "string",
    name: "startDate",
    required: false,
    format: "date",
  },
  {
    kind: "string",
    name: "recordedAt",
    required: false,
    format: "date-time",
  },
  {
    kind: "number",
    name: "ratio",
    required: false,
    minimum: 0,
    maximum: 1,
  },
  {
    kind: "integer",
    name: "retries",
    required: false,
    minimum: 0,
    maximum: 5,
  },
  {
    kind: "boolean",
    name: "enabled",
    required: false,
  },
  {
    kind: "single-select",
    name: "role",
    required: true,
    options: [
      { value: "dev", title: "Developer" },
      { value: "ops", title: "Operations" },
    ],
  },
  {
    kind: "multi-select",
    name: "regions",
    required: true,
    minItems: 1,
    maxItems: 2,
    options: [
      { value: "us", title: "United States" },
      { value: "eu", title: "Europe" },
      { value: "apac", title: "Asia Pacific" },
    ],
  },
];

const values: McpElicitationValues = {
  email: "dev@example.com",
  callback: "https://example.com",
  startDate: "2026-07-19",
  recordedAt: "2026-07-19T10:30:00Z",
  ratio: "0.5",
  retries: "2",
  enabled: false,
  role: "ops",
  regions: ["us", "eu"],
};

afterEach(cleanup);

describe("McpElicitationFormControls", () => {
  it("renders every field kind with native constraints and titled options", () => {
    render(
      <McpElicitationFormControls
        fields={fields}
        values={values}
        onChange={() => undefined}
      />,
    );

    const email = screen.getByLabelText("Email address*") as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.required).toBe(false);
    expect(email.getAttribute("aria-required")).toBe("true");
    expect(email.minLength).toBe(5);
    expect(email.maxLength).toBe(100);
    expect(email.getAttribute("aria-describedby")).toContain("description");

    expect((screen.getByLabelText("callback") as HTMLInputElement).type).toBe(
      "url",
    );
    expect((screen.getByLabelText("startDate") as HTMLInputElement).type).toBe(
      "date",
    );
    expect((screen.getByLabelText("recordedAt") as HTMLInputElement).type).toBe(
      "text",
    );

    const ratio = screen.getByLabelText("ratio") as HTMLInputElement;
    expect(ratio.type).toBe("number");
    expect(ratio.min).toBe("0");
    expect(ratio.max).toBe("1");
    expect(ratio.step).toBe("any");

    const retries = screen.getByLabelText("retries") as HTMLInputElement;
    expect(retries.step).toBe("1");

    const enabled = screen.getByLabelText("enabled") as HTMLInputElement;
    expect(enabled.type).toBe("checkbox");
    expect(enabled.checked).toBe(false);

    const role = screen.getByLabelText("role*") as HTMLSelectElement;
    expect(role.value).toBe("ops");
    expect(screen.getByRole("option", { name: "Developer" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Operations" })).toBeTruthy();

    const regions = screen.getByLabelText("regions*") as HTMLSelectElement;
    expect(regions.multiple).toBe(true);
    expect(
      Array.from(regions.selectedOptions).map((option) => option.value),
    ).toEqual(["us", "eu"]);
  });

  it("emits native control values for both host surfaces", () => {
    const onChange = vi.fn();
    render(
      <McpElicitationFormControls
        fields={fields}
        values={values}
        onChange={onChange}
      />,
    );

    fireEvent.input(screen.getByLabelText("Email address*"), {
      target: { value: "next@example.com" },
    });
    fireEvent.input(screen.getByLabelText("ratio"), {
      target: { value: "0.75" },
    });
    fireEvent.input(screen.getByLabelText("enabled"), {
      target: { checked: true },
    });
    fireEvent.input(screen.getByLabelText("role*"), {
      target: { value: "dev" },
    });

    const regions = screen.getByLabelText("regions*") as HTMLSelectElement;
    for (const option of Array.from(regions.options)) {
      option.selected = option.value === "apac";
    }
    fireEvent.input(regions);

    expect(onChange).toHaveBeenCalledWith("email", "next@example.com");
    expect(onChange).toHaveBeenCalledWith("ratio", "0.75");
    expect(onChange).toHaveBeenCalledWith("enabled", true);
    expect(onChange).toHaveBeenCalledWith("role", "dev");
    expect(onChange).toHaveBeenCalledWith("regions", ["apac"]);
  });

  it("links errors accessibly and disables all controls", () => {
    render(
      <McpElicitationFormControls
        fields={fields}
        values={values}
        errors={{ email: "Email address must be valid." }}
        disabled
        idPrefix="elicitation-test"
        onChange={() => undefined}
      />,
    );

    const email = screen.getByLabelText("Email address*") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(
      "elicitation-test-0-description elicitation-test-0-error",
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Email address must be valid.",
    );

    for (const control of screen.getAllByRole(
      /textbox|spinbutton|checkbox|combobox|listbox/,
    )) {
      expect((control as HTMLInputElement | HTMLSelectElement).disabled).toBe(
        true,
      );
    }
  });
});
