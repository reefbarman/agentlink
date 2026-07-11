// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
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
});
