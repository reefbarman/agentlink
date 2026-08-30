// @vitest-environment jsdom

import type {
  McpConfigBatchMutation,
  McpConfigMutationResult,
  McpConfigSnapshot,
} from "@agentlink/protocol/mcp-manager";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { McpManagerPanel } from "./McpManagerPanel";

function snapshot(
  overrides: Partial<McpConfigSnapshot> = {},
): McpConfigSnapshot {
  return {
    profile: "main",
    version: 1,
    revision: "snapshot-revision",
    sources: [
      {
        id: "global",
        profile: "main",
        scope: "global",
        label: "Global configuration",
        path: "/home/user/.agentlink/mcp.json",
        exists: true,
        editable: true,
        priority: 10,
        readStatus: "available",
        revision: "global-revision",
      },
      {
        id: "project",
        profile: "main",
        scope: "project",
        label: "Project configuration",
        path: "/workspace/.agentlink/mcp.json",
        exists: false,
        editable: true,
        priority: 20,
        readStatus: "missing",
      },
    ],
    entries: [
      {
        name: "configured-only",
        config: {
          name: "configured-only",
          type: "stdio",
          command: "node",
          args: ["script with spaces.js"],
        },
        sourceIds: ["global"],
        editableScopes: ["global"],
        preferredEditScope: "global",
        inherited: false,
        hasSecrets: false,
      },
      {
        name: "disabled-server",
        config: {
          name: "disabled-server",
          type: "stdio",
          command: "node",
          disabled: true,
        },
        sourceIds: ["global"],
        editableScopes: ["global"],
        preferredEditScope: "global",
        inherited: false,
        hasSecrets: false,
      },
    ],
    statusInfos: [
      {
        name: "runtime-only",
        status: "connected",
        toolCount: 1,
        resourceCount: 0,
        promptCount: 0,
        tools: [{ name: "search", description: "Search things" }],
      },
    ],
    capabilities: {
      canEditConfig: true,
      canOpenRawConfig: true,
      canReconnect: true,
      canReauthenticate: true,
      canDisable: true,
      canUseProjectConfig: true,
      canWriteSecrets: true,
      canConfigureLocalProcess: true,
    },
    ...overrides,
  };
}

function successfulResult(
  batch: McpConfigBatchMutation,
): McpConfigMutationResult {
  return {
    operationId: batch.operationId,
    ok: true,
    configSaved: true,
    errors: [],
  };
}

afterEach(cleanup);

describe("McpManagerPanel", () => {
  it("switches projects in one manager and pins mutations to the selected project", async () => {
    const onSelectProject = vi.fn();
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) =>
      successfulResult(batch),
    );
    render(
      <McpManagerPanel
        snapshot={snapshot({
          project: {
            projectId: "project-a",
            displayName: "Project A",
            availability: "available",
          },
          projects: [
            {
              projectId: "project-a",
              displayName: "Project A",
              availability: "available",
            },
            {
              projectId: "project-b",
              displayName: "Project B",
              availability: "available",
            },
          ],
        })}
        onSelectProject={onSelectProject}
        onMutateConfig={onMutateConfig}
      />,
    );

    fireEvent.input(screen.getByLabelText("MCP project"), {
      target: { value: "project-b" },
    });
    expect(onSelectProject).toHaveBeenCalledWith("project-b");

    fireEvent.click(
      screen.getByRole("button", { name: "Disable configured-only" }),
    );
    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(1));
    expect(onMutateConfig.mock.calls[0][0]).toMatchObject({
      projectId: "project-a",
    });
  });

  it("joins configured and runtime servers in the overview, including disabled and not connected", () => {
    render(<McpManagerPanel snapshot={snapshot()} />);

    expect(screen.getAllByText("Configured · not connected")).toHaveLength(1);
    expect(screen.getByText("Disabled in configuration")).toBeTruthy();
    expect(screen.getByText("not connected")).toBeTruthy();
    expect(screen.getAllByText("disabled")).toHaveLength(1);
    expect(screen.getByText("runtime only")).toBeTruthy();
    expect(screen.getAllByText("1", { selector: "strong" })).toHaveLength(3);
  });

  it("hides runtime actions that would be no-ops and inherited-only removal", () => {
    const inheritedEntry = {
      ...snapshot().entries[0],
      name: "inherited-only",
      config: {
        ...snapshot().entries[0].config,
        name: "inherited-only",
      },
      sourceIds: ["inherited"],
      editableScopes: [],
      preferredEditScope: undefined,
      writableOverrideScopes: ["global" as const],
      inherited: true,
    };
    render(
      <McpManagerPanel
        snapshot={snapshot({
          entries: [...snapshot().entries, inheritedEntry],
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Reconnect configured-only" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reauthenticate disabled-server" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Disable inherited-only" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit configured-only" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove configured-only" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove inherited-only" }),
    ).toBeNull();
  });

  it("persists disable and enable through correlated config mutations", async () => {
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) =>
      successfulResult(batch),
    );
    render(
      <McpManagerPanel snapshot={snapshot()} onMutateConfig={onMutateConfig} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Disable configured-only" }),
    );
    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(1));
    expect(onMutateConfig.mock.calls[0][0]).toMatchObject({
      profile: "main",
      scope: "global",
      expectedRevision: "snapshot-revision",
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { name: "configured-only", disabled: true },
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Enable disabled-server" }),
    );
    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(2));
    expect(onMutateConfig.mock.calls[1][0]).toMatchObject({
      operations: [
        {
          server: { name: "disabled-server", disabled: false },
        },
      ],
    });
  });

  it("shows source read health and opens raw configuration by scope", () => {
    const onOpenRawConfig = vi.fn();
    render(
      <McpManagerPanel
        snapshot={snapshot({
          sources: [
            ...snapshot().sources,
            {
              id: "broken",
              profile: "main",
              scope: "global",
              label: "Broken configuration",
              path: "/broken/mcp.json",
              exists: true,
              editable: false,
              priority: 0,
              readStatus: "unreadable",
              readError: "permission_denied",
            },
          ],
        })}
        initialView="sources"
        onOpenRawConfig={onOpenRawConfig}
      />,
    );

    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Not created")).toBeTruthy();
    expect(screen.getByText("Permission denied")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Path and actions")[1]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open raw configuration" })[1],
    );
    expect(onOpenRawConfig).toHaveBeenCalledWith("global");
  });

  it("summarizes existing credential keys without exposing values", () => {
    render(
      <McpManagerPanel
        snapshot={snapshot({
          entries: [
            {
              ...snapshot().entries[0],
              envKeys: ["TOKEN"],
              headerKeys: [],
              hasSecrets: true,
            },
          ],
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit configured-only" }),
    );
    expect(screen.getByText("1 key")).toBeTruthy();
    expect(screen.queryByText(/TOKEN=/)).toBeNull();
  });

  it("selects configured servers to edit from the add or edit tab", () => {
    render(<McpManagerPanel snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Add / edit" }));
    let serverSelector = screen.getByLabelText(
      "Server to configure",
    ) as HTMLSelectElement;
    expect(serverSelector.value).toBe("");
    expect(
      Array.from(serverSelector.options).map((option) => option.value),
    ).toEqual(["", "configured-only", "disabled-server"]);

    fireEvent.input(serverSelector, {
      target: { value: "configured-only" },
    });
    expect(
      screen.getByRole("form", { name: "Edit configured-only" }),
    ).toBeTruthy();
    const editName = screen.getByLabelText("Server name") as HTMLInputElement;
    expect(editName.value).toBe("configured-only");
    expect(editName.disabled).toBe(true);
    expect((screen.getByLabelText("Command") as HTMLInputElement).value).toBe(
      "node",
    );
    expect(
      (screen.getByLabelText(/^Arguments/) as HTMLTextAreaElement).value,
    ).toBe("script with spaces.js");

    serverSelector = screen.getByLabelText(
      "Server to configure",
    ) as HTMLSelectElement;
    fireEvent.input(serverSelector, { target: { value: "disabled-server" } });
    expect(
      screen.getByRole("form", { name: "Edit disabled-server" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Server name") as HTMLInputElement).value,
    ).toBe("disabled-server");
    expect(
      (screen.getByLabelText("Keep this server disabled") as HTMLInputElement)
        .checked,
    ).toBe(true);

    serverSelector = screen.getByLabelText(
      "Server to configure",
    ) as HTMLSelectElement;
    fireEvent.input(serverSelector, { target: { value: "" } });
    expect(screen.getByRole("form", { name: "Add MCP server" })).toBeTruthy();
    const newName = screen.getByLabelText("Server name") as HTMLInputElement;
    expect(newName.value).toBe("");
    expect(newName.disabled).toBe(false);
    expect((screen.getByLabelText("Command") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("reflects an overview edit action in the server selector", () => {
    render(<McpManagerPanel snapshot={snapshot()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Edit configured-only" }),
    );

    expect(
      (screen.getByLabelText("Server to configure") as HTMLSelectElement).value,
    ).toBe("configured-only");
  });

  it("locks server selection during saves and confirms completion", async () => {
    let resolveSave: ((result: McpConfigMutationResult) => void) | undefined;
    const onMutateConfig = vi.fn(
      (batch: McpConfigBatchMutation) =>
        new Promise<McpConfigMutationResult>((resolve) => {
          resolveSave = () => resolve(successfulResult(batch));
        }),
    );
    render(
      <McpManagerPanel snapshot={snapshot()} onMutateConfig={onMutateConfig} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit configured-only" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByLabelText("Server to configure") as HTMLSelectElement)
        .disabled,
    ).toBe(true);

    resolveSave?.(successfulResult(onMutateConfig.mock.calls[0][0]));
    await waitFor(() => expect(screen.getByText("Server saved.")).toBeTruthy());
    expect(screen.getByText("configured-only")).toBeTruthy();
  });

  it("preserves spaces in line arguments and submits explicit secret patch mutations", async () => {
    const batches: McpConfigBatchMutation[] = [];
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) => {
      batches.push(batch);
      return successfulResult(batch);
    });
    render(
      <McpManagerPanel
        snapshot={snapshot()}
        initialView="guided"
        onMutateConfig={onMutateConfig}
      />,
    );

    fireEvent.input(screen.getByLabelText("Server name"), {
      target: { value: "new-server" },
    });
    fireEvent.input(screen.getByLabelText("Command"), {
      target: { value: "node" },
    });
    fireEvent.input(screen.getByLabelText(/^Arguments/), {
      target: { value: "script with spaces.js\n--flag=value" },
    });
    fireEvent.click(
      screen.getByLabelText(/Server supports parallel tool calls/),
    );
    expect(screen.getByText("Advanced settings")).toBeTruthy();
    fireEvent.click(screen.getByText("Credentials"));
    fireEvent.input(
      screen.getByLabelText("Environment variables update mode"),
      {
        target: { value: "patch" },
      },
    );
    fireEvent.input(screen.getByLabelText(/^Environment variables values/), {
      target: { value: "TOKEN=secret=value\nNEW=value" },
    });
    fireEvent.input(
      screen.getByLabelText(/^Environment variables keys to remove/),
      {
        target: { value: "OLD_TOKEN" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(1));
    expect(batches[0]).toMatchObject({
      profile: "main",
      scope: "project",
      expectedRevision: "snapshot-revision",
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: {
            name: "new-server",
            command: "node",
            args: ["script with spaces.js", "--flag=value"],
            supportsParallelToolCalls: true,
            env: {
              mode: "patch",
              set: { TOKEN: "secret=value", NEW: "value" },
              remove: ["OLD_TOKEN"],
            },
            headers: { mode: "preserve" },
          },
        },
      ],
    });
  });

  it("accepts arguments as a JSON string array and reports malformed arrays locally", async () => {
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) =>
      successfulResult(batch),
    );
    render(
      <McpManagerPanel
        snapshot={snapshot()}
        initialView="guided"
        onMutateConfig={onMutateConfig}
      />,
    );

    fireEvent.input(screen.getByLabelText("Server name"), {
      target: { value: "json-args" },
    });
    fireEvent.input(screen.getByLabelText("Command"), {
      target: { value: "node" },
    });
    fireEvent.input(screen.getByLabelText(/^Arguments/), {
      target: { value: '["one value", 2]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Arguments JSON must be an array of strings.",
    );
    expect(onMutateConfig).not.toHaveBeenCalled();

    fireEvent.input(screen.getByLabelText(/^Arguments/), {
      target: { value: '["one value", "two"]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(1));
    expect(onMutateConfig.mock.calls[0][0].operations[0]).toMatchObject({
      server: { args: ["one value", "two"] },
    });
  });

  it("parses import rows locally and submits selected conflict actions as one batch", async () => {
    const importedSnapshot = snapshot({
      entries: [
        {
          name: "configured-only",
          config: {
            name: "configured-only",
            type: "stdio",
            command: "old-command",
          },
          sourceIds: ["global"],
          editableScopes: ["global"],
          preferredEditScope: "global",
          inherited: false,
          hasSecrets: false,
        },
      ],
    });
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) =>
      successfulResult(batch),
    );
    render(
      <McpManagerPanel
        snapshot={importedSnapshot}
        initialView="import"
        onMutateConfig={onMutateConfig}
      />,
    );

    fireEvent.input(screen.getByLabelText("MCP configuration JSON"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            "configured-only": { command: "new-command" },
            added: {
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer secret" },
            },
            broken: { args: ["missing endpoint"] },
          },
        }),
      },
    });

    expect(
      await screen.findByRole("region", { name: "Import review" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Server must specify exactly one command or URL endpoint.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Import broken") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.input(
      screen.getByLabelText("Conflict action for configured-only"),
      {
        target: { value: "rename" },
      },
    );
    fireEvent.input(screen.getByLabelText("New name for configured-only"), {
      target: { value: "added" },
    });
    expect(
      screen.getByText("More than one selected row would use added."),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Apply selected",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.input(screen.getByLabelText("New name for configured-only"), {
      target: { value: "configured-copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));

    await waitFor(() => expect(onMutateConfig).toHaveBeenCalledTimes(1));
    expect(onMutateConfig.mock.calls[0][0]).toMatchObject({
      profile: "main",
      scope: "project",
      operations: [
        {
          kind: "upsert",
          conflictAction: "rename",
          renameTo: "configured-copy",
          server: { name: "configured-only", command: "new-command" },
        },
        {
          kind: "upsert",
          conflictAction: "replace",
          server: {
            name: "added",
            url: "https://example.com/mcp",
            headers: {
              mode: "replace",
              set: { Authorization: "Bearer secret" },
            },
          },
        },
      ],
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Apply selected",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
  });

  it("requires explicit removal instead of allowing an empty secret replacement", async () => {
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) =>
      successfulResult(batch),
    );
    render(
      <McpManagerPanel
        snapshot={snapshot()}
        initialView="guided"
        onMutateConfig={onMutateConfig}
      />,
    );

    fireEvent.input(screen.getByLabelText("Server name"), {
      target: { value: "safe-secrets" },
    });
    fireEvent.input(screen.getByLabelText("Command"), {
      target: { value: "node" },
    });
    fireEvent.click(screen.getByText("Credentials"));
    fireEvent.input(
      screen.getByLabelText("Environment variables update mode"),
      { target: { value: "replace" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Environment variables replacement requires at least one KEY=value pair.",
    );
    expect(onMutateConfig).not.toHaveBeenCalled();
  });

  it("blocks unsupported local-process guided and import mutations", async () => {
    const restrictedSnapshot = snapshot({
      capabilities: {
        ...snapshot().capabilities,
        canConfigureLocalProcess: false,
      },
    });
    const onMutateConfig = vi.fn(async (batch: McpConfigBatchMutation) =>
      successfulResult(batch),
    );
    const { rerender } = render(
      <McpManagerPanel
        snapshot={restrictedSnapshot}
        onMutateConfig={onMutateConfig}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Disable configured-only" }),
    ).toBeNull();

    rerender(
      <McpManagerPanel
        snapshot={restrictedSnapshot}
        initialView="guided"
        onMutateConfig={onMutateConfig}
      />,
    );
    fireEvent.input(screen.getByLabelText("Server name"), {
      target: { value: "unsupported-local" },
    });
    fireEvent.input(screen.getByLabelText("Command"), {
      target: { value: "node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This host cannot configure local-process servers.",
    );
    expect(onMutateConfig).not.toHaveBeenCalled();

    rerender(
      <McpManagerPanel
        snapshot={restrictedSnapshot}
        initialView="import"
        onMutateConfig={onMutateConfig}
      />,
    );
    fireEvent.input(screen.getByLabelText("MCP configuration JSON"), {
      target: {
        value: JSON.stringify({ local: { command: "node" } }),
      },
    });
    const selection = (await screen.findByLabelText(
      "Import local",
    )) as HTMLInputElement;
    expect(selection.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Apply selected",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("retains legacy save compatibility and disables import without batch support", () => {
    const onSaveServer = vi.fn();
    const { rerender } = render(
      <McpManagerPanel
        snapshot={snapshot()}
        initialView="guided"
        onSaveServer={onSaveServer}
      />,
    );
    fireEvent.input(screen.getByLabelText("Server name"), {
      target: { value: "legacy" },
    });
    fireEvent.input(screen.getByLabelText("Command"), {
      target: { value: "node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    expect(onSaveServer).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({ name: "legacy", command: "node" }),
    );

    rerender(<McpManagerPanel snapshot={snapshot()} initialView="import" />);
    expect(
      (
        screen.getByRole("button", {
          name: "Apply selected",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        "JSON import requires a host with batch config mutation support.",
      ),
    ).toBeTruthy();
  });
});
