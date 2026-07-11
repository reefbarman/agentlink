import * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { addTrustedCommandViaUi } from "./trustedCommandFlow.js";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

interface PickItem {
  label: string;
  description?: string;
  mode?: "prefix" | "exact" | "regex";
  scope?: "project" | "global";
}

function createApprovalManager() {
  return { addCommandRule: vi.fn() };
}

function selectByLabel(label: string) {
  return async (items: readonly PickItem[]) =>
    items.find((item) => item.label === label);
}

describe("addTrustedCommandViaUi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(vscode.window, { showInputBox: vi.fn() });
    Object.assign(vscode.workspace, { workspaceFolders: undefined });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(
      undefined,
    );
  });

  it("validates, trims, and persists a project-scoped prefix rule", async () => {
    const approvalManager = createApprovalManager();
    Object.assign(vscode.workspace, {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: "/workspace" } }],
    });
    vi.mocked(vscode.window.showInputBox).mockImplementation(
      async (options) => {
        expect(options).toBeDefined();
        expect(options!.validateInput?.("   ")).toBe("Pattern cannot be empty");
        expect(options!.validateInput?.(" npm ")).toBeNull();
        return "  npm run  ";
      },
    );
    vi.mocked(vscode.window.showQuickPick)
      .mockImplementationOnce(selectByLabel("Prefix Match") as never)
      .mockImplementationOnce(selectByLabel("$(folder) This Project") as never);

    await addTrustedCommandViaUi(approvalManager);

    expect(vscode.window.showQuickPick).toHaveBeenNthCalledWith(
      1,
      [
        {
          label: "Prefix Match",
          description: 'Trust commands starting with "npm run"',
          mode: "prefix",
        },
        {
          label: "Exact Match",
          description: 'Trust only "npm run"',
          mode: "exact",
        },
        {
          label: "Regex Match",
          description: "Trust commands matching /npm run/",
          mode: "regex",
        },
      ],
      {
        title: "Match Mode",
        placeHolder: "How should this pattern match commands?",
        ignoreFocusOut: true,
      },
    );
    expect(vscode.window.showQuickPick).toHaveBeenNthCalledWith(
      2,
      [
        {
          label: "$(folder) This Project",
          description: ".agentlink/agentlink.json",
          scope: "project",
        },
        {
          label: "$(globe) Global",
          description: "~/.agentlink/agentlink.json",
          scope: "global",
        },
      ],
      {
        title: "Rule Scope",
        placeHolder: "Where should this rule be saved?",
        ignoreFocusOut: true,
      },
    );
    expect(approvalManager.addCommandRule).toHaveBeenCalledWith(
      "_global",
      { pattern: "npm run", mode: "prefix" },
      "project",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Added trusted command (project): prefix "npm run"',
    );
  });

  it("offers only global scope outside a workspace", async () => {
    const approvalManager = createApprovalManager();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("git status");
    vi.mocked(vscode.window.showQuickPick)
      .mockImplementationOnce(selectByLabel("Exact Match") as never)
      .mockImplementationOnce(selectByLabel("$(globe) Global") as never);

    await addTrustedCommandViaUi(approvalManager);

    expect(vscode.window.showQuickPick).toHaveBeenNthCalledWith(
      2,
      [
        {
          label: "$(globe) Global",
          description: "~/.agentlink/agentlink.json",
          scope: "global",
        },
      ],
      expect.objectContaining({ title: "Rule Scope" }),
    );
    expect(approvalManager.addCommandRule).toHaveBeenCalledWith(
      "_global",
      { pattern: "git status", mode: "exact" },
      "global",
    );
  });

  it.each([
    ["pattern", 0],
    ["mode", 1],
    ["scope", 2],
  ] as const)(
    "does not persist when %s selection is cancelled",
    async (step, calls) => {
      const approvalManager = createApprovalManager();
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(
        step === "pattern" ? undefined : "echo",
      );
      if (step === "scope") {
        vi.mocked(vscode.window.showQuickPick)
          .mockImplementationOnce(selectByLabel("Regex Match") as never)
          .mockResolvedValueOnce(undefined);
      }

      await addTrustedCommandViaUi(approvalManager);

      expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(calls);
      expect(approvalManager.addCommandRule).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    },
  );
});
