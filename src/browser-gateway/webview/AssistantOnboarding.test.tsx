// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SetupPanel,
  setupStatusLabel,
  type OnboardingState,
  type OpenAiStatus,
} from "./AssistantOnboarding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const STATE: OnboardingState = {
  record: { revision: 0, freshInstall: true, steps: {} },
  facts: {
    model: { codexAvailable: true, codexSignedIn: false, otherProviders: 0 },
    backup: { configured: true, lastSuccessAt: 1_700_000_000_000 },
  },
  status: "setup-incomplete",
  openSetup: true,
};

const CALLBACK = "http://localhost:1455/auth/callback?code=c&state=s";

const KEY = `sk-proj-${"z".repeat(40)}`;
const CODEX_MODEL = {
  providerId: "codex",
  modelId: "gpt-codex",
  displayName: "GPT Codex",
};
const API_MODEL = {
  providerId: "openai",
  modelId: "gpt-api",
  displayName: "GPT API",
  providerDisplayName: "OpenAI API",
};

function stubServer(options: { openai?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let signedIn = false;
  let state = structuredClone(STATE);
  let openai: OpenAiStatus = {
    revision: 0,
    openai: { state: options.openai ? "not-set" : "unavailable" },
    openAiModels: [API_MODEL],
    availableModels: [CODEX_MODEL],
    defaultModel: { providerId: "codex", modelId: "gpt-codex" },
    defaultModelSource: "server",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      const codex = () => ({
        available: true,
        accounts: signedIn ? [{ label: "me@example.com", active: true }] : [],
        pending: null,
      });
      if (url === "/api/providers/codex") return json(codex());
      if (url === "/api/providers/openai") return json(openai);
      if (url === "/api/providers/openai/key" && method === "PUT") {
        if (body.apiKey !== KEY) {
          return new Response(JSON.stringify({ error: "api_key_invalid" }), {
            status: 400,
          });
        }
        openai = {
          ...openai,
          revision: openai.revision + 1,
          openai: { state: "saved", label: "sk-…zzzz" },
          availableModels: [CODEX_MODEL, API_MODEL],
        };
        state.facts.model.openAiKeySaved = true;
        return json(openai);
      }
      if (url === "/api/providers/default-model") {
        openai = {
          ...openai,
          revision: openai.revision + 1,
          defaultModel: body.model,
          defaultModelSource: "setup",
        };
        return json(openai);
      }
      if (url === "/api/providers/codex/sign-in") {
        return json({ authorizeUrl: "https://auth.openai.com/authorize?x" });
      }
      if (url === "/api/providers/codex/sign-in/complete") {
        signedIn = true;
        state.facts.model.codexSignedIn = true;
        return json(codex());
      }
      if (url === "/api/onboarding") {
        if (method === "PATCH") {
          const record = state.record!;
          state = {
            ...state,
            record: {
              ...record,
              revision: record.revision + 1,
              ...(body.backupPasswordSaved ? { backupPasswordSavedAt: 1 } : {}),
              ...(body.complete ? { completedAt: 1 } : {}),
            },
          };
        }
        return json(state);
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return { calls };
}

describe("setup panel", () => {
  it("signs in to ChatGPT with a pasted callback address and records progress", async () => {
    const server = stubServer();
    const onClose = vi.fn();
    render(
      <SetupPanel initial={STATE} onClose={onClose} openPanel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with ChatGPT" }),
    );
    const link = await screen.findByRole("link", {
      name: "Open ChatGPT sign-in",
    });
    expect(link.getAttribute("href")).toBe(
      "https://auth.openai.com/authorize?x",
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.input(screen.getByRole("textbox"), {
      target: { value: ` ${CALLBACK} ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await screen.findByText(/Signed in as me@example.com/u);
    expect(
      server.calls.find((call) => call.url.endsWith("/complete"))?.body,
    ).toEqual({ redirectUrl: CALLBACK });
    // The pasted address is never kept in browser storage.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("code=c");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "PATCH")?.body,
      ).toEqual({
        expectedRevision: 0,
        step: { id: "model", state: "done" },
      }),
    );
    await screen.findByRole("heading", {
      name: "Name, time zone and quiet hours",
    });
  });

  it("saves an OpenAI key write-only, explains billing and sends nothing else", async () => {
    const server = stubServer({ openai: true });
    render(
      <SetupPanel initial={STATE} onClose={vi.fn()} openPanel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    await screen.findByText(/billed by OpenAI to the key's account/u);
    const field = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    // A wrong paste is refused and the field is cleared anyway.
    fireEvent.input(field, { target: { value: "not a key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText(/does not look like an OpenAI API key/u);
    expect(field.value).toBe("");
    const saveButton = await screen.findByRole("button", { name: "Save key" });
    fireEvent.input(field, { target: { value: ` ${KEY} ` } });
    fireEvent.click(saveButton);
    await screen.findByText(/Key saved \(sk-…zzzz\)/u);
    expect(
      (screen.getByLabelText("Replace the key") as HTMLInputElement).value,
    ).toBe("");
    expect(
      server.calls
        .filter((call) => call.url === "/api/providers/openai/key")
        .at(-1)?.body,
    ).toEqual({ expectedRevision: 0, apiKey: KEY });
    // The key is never shown again or kept in browser storage.
    expect(document.body.textContent).not.toContain(KEY);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(KEY);
    // Choosing the model for new chats is a separate, explicit step.
    expect(
      server.calls.some((call) => call.url === "/api/providers/default-model"),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("Model for new chats"), {
      target: { value: "openai/gpt-api" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use for new chats" }));
    await screen.findByText(/Now: GPT API \(OpenAI API\) \(chosen here\)/u);
    expect(
      server.calls.find((call) => call.url === "/api/providers/default-model")
        ?.body,
    ).toEqual({
      expectedRevision: 1,
      model: { providerId: "openai", modelId: "gpt-api" },
    });
    // Nothing contacted OpenAI or any other address.
    expect(server.calls.every((call) => call.url.startsWith("/api/"))).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "Name, time zone and quiet hours",
    });
  });

  it("only finishes once the backup password is acknowledged", async () => {
    stubServer();
    const onClose = vi.fn();
    const ready: OnboardingState = {
      ...STATE,
      facts: {
        ...STATE.facts,
        model: { ...STATE.facts.model, codexSignedIn: true },
      },
    };
    render(
      <SetupPanel initial={ready} onClose={onClose} openPanel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const finish = screen.getByRole("button", { name: "Finish setup" });
    expect((finish as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    await screen.findByText("You said it is saved off this machine.");
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(null));
  });

  it("opens other panels for optional connections instead of connecting anything", async () => {
    stubServer();
    const openPanel = vi.fn();
    render(
      <SetupPanel initial={STATE} onClose={vi.fn()} openPanel={openPanel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
    expect(openPanel).toHaveBeenCalledWith("github");
  });

  it("shows optional features with fixed local commands and no way to run them", async () => {
    const server = stubServer();
    render(
      <SetupPanel
        initial={{
          ...STATE,
          facts: {
            ...STATE.facts,
            features: { editor: "on", browser: "off" },
          },
        }}
        onClose={vi.fn()}
        openPanel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    const section = screen.getByRole("region", { name: "Optional features" });
    expect(section.textContent).toContain("Edit task workspaces");
    expect(section.textContent).toContain(
      "bash ~/agentlink-assistant/install.sh disable editor",
    );
    expect(section.textContent).toContain(
      "bash ~/agentlink-assistant/install.sh enable browser",
    );
    expect(section.textContent).toContain("Advanced setup by hand");
    // Status and instructions only: nothing in it can be clicked or sent.
    expect(section.querySelectorAll("button, input, a")).toHaveLength(0);
    expect(server.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("explains a feature that needs session runners instead of offering a command", async () => {
    stubServer();
    render(
      <SetupPanel
        initial={{
          ...STATE,
          facts: {
            ...STATE.facts,
            features: { editor: "needs-runners", browser: "needs-runners" },
          },
        }}
        onClose={vi.fn()}
        openPanel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    const section = screen.getByRole("region", { name: "Optional features" });
    expect(section.textContent).toContain("needs session runners");
    expect(section.textContent).not.toContain("install.sh enable");
  });

  it("labels the overall state", () => {
    expect(setupStatusLabel("ready")).toBe("Set up");
    expect(setupStatusLabel("backup-degraded")).toMatch(/backups/u);
    expect(setupStatusLabel("setup-incomplete")).toBe("Setup not finished");
  });
});
