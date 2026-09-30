// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";

import { ProviderUsagePanel } from "./ProviderUsageBlock";

afterEach(cleanup);

describe("ProviderUsagePanel", () => {
  it("shows the CLI account and account-switching guidance", () => {
    render(
      <ProviderUsagePanel
        data={{
          queriedAt: Date.now(),
          providers: [
            {
              providerId: "openai-codex",
              providerName: "Codex",
              available: true,
              accountLabel: "person@example.com",
              accountSource: "Signed in to the Codex CLI",
              planType: "plus",
              switchAccountInstructions:
                "Run codex logout, then codex login, and run /usage again.",
              rateLimits: [
                {
                  id: "codex",
                  primary: { usedPercent: 25, resetsAt: 1_800_000_000 },
                },
              ],
            },
          ],
        }}
        onClose={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("person@example.com")).toBeTruthy();
    expect(screen.getByText("Signed in to the Codex CLI")).toBeTruthy();
    expect(screen.getByText("Show usage for another account")).toBeTruthy();
    expect(screen.getByText(/codex logout/)).toBeTruthy();
  });

  it("renders separate Meridian accounts without fabricating unknown usage", () => {
    const now = 1_800_000_000_000;
    render(
      <ProviderUsagePanel
        data={{
          queriedAt: now,
          providers: [
            {
              providerId: "openai-compatible:meridian",
              providerName: "Meridian",
              available: true,
              notice: "Showing the last successful reading.",
              accounts: [
                {
                  id: "work",
                  label: "work",
                  isActive: true,
                  available: true,
                  stale: false,
                  observedAtMs: now - 30_000,
                  windows: [
                    {
                      id: "five_hour",
                      label: "5-hour",
                      usedPercent: 42,
                      resetsAt: now / 1_000 + 3_600,
                    },
                    {
                      id: "seven_day",
                      label: "Weekly",
                      usedPercent: null,
                      resetsAt: null,
                    },
                  ],
                },
                {
                  id: "api",
                  label: "api",
                  isActive: false,
                  available: false,
                  reason: "No subscription allowance.",
                  stale: true,
                  observedAtMs: null,
                  windows: [],
                },
              ],
            },
          ],
        }}
        onClose={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.getByText("usage unknown")).toBeTruthy();
    expect(screen.getByText("read 30s ago")).toBeTruthy();
    expect(screen.getByText("No subscription allowance.")).toBeTruthy();
    expect(screen.getByText("stale")).toBeTruthy();
    expect(
      screen.getByText("Showing the last successful reading."),
    ).toBeTruthy();
  });
});
