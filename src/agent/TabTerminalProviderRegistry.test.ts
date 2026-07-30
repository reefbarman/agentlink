import { describe, expect, it, vi } from "vitest";

import {
  sameTerminalOwnerScope,
  type ClosedTerminalSnapshot,
  type TerminalBackgroundState,
  type TerminalExecuteOptions,
  type TerminalExecutionOwner,
  type TerminalMetadata,
  type TerminalProvider,
} from "../core/capabilities/terminal.js";
import { TerminalTargetRecoveryError } from "../core/capabilities/terminalTargetError.js";
import {
  TabTerminalProviderRegistry,
  type TabTerminalOwner,
} from "./TabTerminalProviderRegistry.js";

function createProvider() {
  const terminals = new Map<string, TerminalMetadata>();
  const states = new Map<string, TerminalBackgroundState>();
  const recentlyClosed: ClosedTerminalSnapshot[] = [];
  const executionKeys = new Map<string, string>();
  let nextId = 1;

  const owned = (
    id: string,
    owner: TerminalExecutionOwner | undefined,
  ): TerminalMetadata | undefined => {
    const terminal = terminals.get(id);
    return terminal &&
      (owner === undefined || sameTerminalOwnerScope(terminal.owner, owner))
      ? terminal
      : undefined;
  };

  const provider: TerminalProvider = {
    executeCommand: vi.fn(async (options: TerminalExecuteOptions) => {
      const implicitKey = JSON.stringify({
        owner: options.owner,
        cwd: options.cwd,
        env: options.env ?? {},
        name: options.terminal_creation_name ?? "AgentLink",
      });
      const reusableId = options.terminal_name
        ? undefined
        : [...executionKeys].find(([, key]) => key === implicitKey)?.[0];
      const id = options.terminal_id ?? reusableId ?? `term_${nextId++}`;
      const name =
        terminals.get(id)?.name ??
        options.terminal_name ??
        options.terminal_creation_name ??
        "AgentLink";
      terminals.set(id, {
        id,
        name,
        busy: false,
        ...(options.owner ? { owner: { ...options.owner } } : {}),
      });
      if (!options.terminal_name) executionKeys.set(id, implicitKey);
      states.set(id, {
        is_running: false,
        state: "completed",
        exit_code: 0,
        output: `output:${id}`,
        output_captured: true,
      });
      options.onTerminalAssigned?.(id);
      return {
        exit_code: 0,
        output: `output:${id}`,
        output_captured: true,
        terminal_id: id,
        terminal_name: name,
      };
    }),
    getBackgroundState: vi.fn((request) =>
      owned(request.terminalId, request.owner)
        ? states.get(request.terminalId)
        : undefined,
    ),
    getCurrentOutput: vi.fn((request) =>
      owned(request.terminalId, request.owner)
        ? states.get(request.terminalId)?.output
        : undefined,
    ),
    getRetainedOutput: vi.fn((request) => {
      const state = owned(request.terminalId, request.owner)
        ? states.get(request.terminalId)
        : undefined;
      return state
        ? {
            output: state.output,
            complete: true,
            finalized: true,
            total_bytes: state.output.length,
            retained_bytes: state.output.length,
            dropped_bytes: 0,
          }
        : undefined;
    }),
    interruptTerminal: vi.fn((request) =>
      Boolean(owned(request.terminalId, request.owner)),
    ),
    detachTerminal: vi.fn((request) =>
      Boolean(owned(request.terminalId, request.owner)),
    ),
    revealTerminal: vi.fn((request) =>
      Boolean(owned(request.terminalId, request.owner)),
    ),
    getRecentlyClosedTerminals: vi.fn((request) =>
      recentlyClosed
        .filter(
          (terminal) =>
            request.owner === undefined ||
            sameTerminalOwnerScope(terminal.owner, request.owner),
        )
        .slice(0, request.limit ?? 5),
    ),
    listTerminals: vi.fn((request) =>
      [...terminals.values()].filter(
        (terminal) =>
          request.owner === undefined ||
          sameTerminalOwnerScope(terminal.owner, request.owner),
      ),
    ),
    closeTerminals: vi.fn((request) => {
      const available = [...terminals.values()].filter(
        (terminal) =>
          request.owner === undefined ||
          sameTerminalOwnerScope(terminal.owner, request.owner),
      );
      const targets = request.names ?? available.map((terminal) => terminal.id);
      let closed = 0;
      const notFound: string[] = [];
      for (const target of targets) {
        const metadata =
          terminals.get(target) ??
          [...terminals.values()].find((terminal) => terminal.name === target);
        if (!metadata) {
          notFound.push(target);
          continue;
        }
        terminals.delete(metadata.id);
        const state = states.get(metadata.id);
        states.delete(metadata.id);
        recentlyClosed.unshift({
          id: metadata.id,
          name: metadata.name,
          closedAt: Date.now(),
          ...(metadata.owner ? { owner: { ...metadata.owner } } : {}),
          is_running: false,
          state: state?.state ?? "unknown_termination",
          exit_code: state?.exit_code ?? null,
          output: state?.output ?? "",
          output_captured: state?.output_captured ?? false,
        });
        closed += 1;
      }
      return {
        closed,
        ...(notFound.length > 0 ? { not_found: notFound } : {}),
      };
    }),
  };
  return { provider, terminals, states };
}

const t1: TabTerminalOwner = {
  tabId: "tab-1",
  tabLabel: "T1",
  sessionId: "session-1",
  generation: 1,
};
const t2: TabTerminalOwner = {
  tabId: "tab-2",
  tabLabel: "T2",
  sessionId: "session-2",
  generation: 1,
};

describe("TabTerminalProviderRegistry", () => {
  it("titles terminals by stable tab label and reuses only within the owner generation", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const first = registry.forOwner(t1);
    const second = registry.forOwner(t2);

    const t1First = await first.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/tmp",
    });
    const t1Second = await first.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/tmp",
    });
    const t2First = await second.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/tmp",
    });

    expect(t1Second.terminal_id).toBe(t1First.terminal_id);
    expect(t2First.terminal_id).not.toBe(t1First.terminal_id);
    expect(t1First.terminal_name).toBe("AgentLink");
    expect(base.terminals.get(t1First.terminal_id)?.name).toBe(
      "AgentLink T1 · Pool",
    );
    expect(base.terminals.get(t2First.terminal_id)?.name).toBe(
      "AgentLink T2 · Pool",
    );
  });

  it("preserves implicit execution intent while providing a physical creation title", async () => {
    const base = createProvider();
    const provider = new TabTerminalProviderRegistry(base.provider).forOwner(
      t1,
    );

    await provider.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/tmp",
    });

    const forwarded = vi.mocked(base.provider.executeCommand).mock
      .calls[0]?.[0];
    expect(forwarded).toEqual(
      expect.objectContaining({
        terminal_name: undefined,
        terminal_creation_name: "AgentLink T1 · Pool",
      }),
    );
    expect(forwarded).not.toHaveProperty("terminal_id");
  });

  it("fails closed for explicit cross-owner IDs, names, output, and control", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const first = registry.forOwner(t1);
    const second = registry.forOwner(t2);
    const created = await first.executeCommand({
      owner: undefined,
      command: "npm test",
      cwd: "/tmp",
      terminal_name: "Tests",
    });

    await expect(
      second.executeCommand({
        owner: undefined,
        command: "npm test",
        cwd: "/tmp",
        terminal_id: created.terminal_id,
      }),
    ).rejects.toThrow(`Terminal not found: ${created.terminal_id}`);
    expect(
      second.getBackgroundState({
        owner: undefined,
        terminalId: created.terminal_id,
      }),
    ).toBeUndefined();
    expect(
      second.getRetainedOutput?.({
        owner: undefined,
        terminalId: created.terminal_id,
      }),
    ).toBeUndefined();
    expect(
      second.interruptTerminal({
        owner: undefined,
        terminalId: created.terminal_id,
      }),
    ).toBe(false);
    expect(
      second.revealTerminal?.({
        owner: undefined,
        terminalId: created.terminal_id,
      }),
    ).toBe(false);

    const secondNamed = await second.executeCommand({
      owner: undefined,
      command: "npm test",
      cwd: "/tmp",
      terminal_name: "Tests",
    });
    expect(secondNamed.terminal_id).not.toBe(created.terminal_id);
    expect(secondNamed.terminal_name).toBe("Tests");
  });

  it("returns owner-scoped logical candidates for stale split_from", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const first = registry.forOwner(t1);
    const second = registry.forOwner(t2);
    const firstTerminal = await first.executeCommand({
      owner: undefined,
      command: "one",
      cwd: "/tmp",
      terminal_name: "Tests",
    });
    const secondTerminal = await second.executeCommand({
      owner: undefined,
      command: "two",
      cwd: "/tmp",
      terminal_name: "Other",
    });

    let error: unknown;
    try {
      await first.prepareExecution?.(
        {
          owner: undefined,
          command: "three",
          cwd: "/tmp",
          split_from: "closed-terminal",
        },
        {
          approvalPolicySnapshot: "on-request",
          approvalReviewerSnapshot: "auto-review",
          executionPresetSnapshot: "workspace-write",
          requiredAuthority: "sandbox",
          permissionIntent: "default",
          approvalRequirement: "policy",
          authorityReason: "approval-policy",
          commandApprovalPolicySnapshot: "approve-for-me",
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TerminalTargetRecoveryError);
    expect(error).toMatchObject({
      failure: "not_found",
      target_kind: "split_from",
      target_value: "closed-terminal",
      compatible_terminals: [
        {
          terminal_id: firstTerminal.terminal_id,
          terminal_name: "Tests",
        },
      ],
    });
    expect((error as Error).message).toContain(
      `split_from="${firstTerminal.terminal_id}"`,
    );
    expect((error as Error).message).toContain("retry without split_from");
    expect((error as Error).message).not.toContain(secondTerminal.terminal_id);
    expect((error as Error).message).not.toContain("AgentLink T1");
  });

  it("reports an ambiguous split_from name and lists exact terminal IDs", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const provider = registry.forOwner(t1);
    const first = await provider.executeCommand({
      owner: undefined,
      command: "one",
      cwd: "/tmp",
      terminal_name: "Tests",
    });
    const second = await provider.executeCommand({
      owner: undefined,
      command: "two",
      cwd: "/tmp",
      terminal_name: "Tests",
    });

    let error: unknown;
    try {
      await provider.prepareExecution?.(
        {
          owner: undefined,
          command: "three",
          cwd: "/tmp",
          split_from: "Tests",
        },
        {
          approvalPolicySnapshot: "on-request",
          approvalReviewerSnapshot: "auto-review",
          executionPresetSnapshot: "workspace-write",
          requiredAuthority: "sandbox",
          permissionIntent: "default",
          approvalRequirement: "policy",
          authorityReason: "approval-policy",
          commandApprovalPolicySnapshot: "approve-for-me",
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TerminalTargetRecoveryError);
    expect(error).toMatchObject({
      failure: "ambiguous_name",
      target_kind: "split_from",
      target_value: "Tests",
    });
    expect((error as Error).message).toContain(
      `split_from="${first.terminal_id}"`,
    );
    expect((error as Error).message).toContain(
      `split_from="${second.terminal_id}"`,
    );
    expect((error as Error).message).toContain("retry without split_from");
  });

  it("translates physical recovery targets back to logical names", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const provider = registry.forOwner(t1);
    const created = await provider.executeCommand({
      owner: undefined,
      command: "one",
      cwd: "/tmp",
      terminal_name: "Tests",
    });
    base.provider.prepareExecution = vi.fn(async () => {
      throw new TerminalTargetRecoveryError({
        failure: "wrong_authority",
        target_kind: "terminal_name",
        target_value: "AgentLink T1 · Tests",
        required_authority: "native-agent",
        target_authorities: ["sandbox"],
        compatible_terminals: [
          {
            terminal_id: created.terminal_id,
            terminal_name: "AgentLink T1 · Tests",
            authority: "sandbox",
          },
        ],
        retry_guidance: [
          'Retry with terminal_name="AgentLink T1 · Tests" under sandbox authority.',
        ],
      });
    });

    let error: unknown;
    try {
      await provider.prepareExecution?.(
        {
          owner: undefined,
          command: "two",
          cwd: "/tmp",
          terminal_name: "Tests",
        },
        {
          approvalPolicySnapshot: "on-request",
          approvalReviewerSnapshot: "user",
          executionPresetSnapshot: "native-manual",
          requiredAuthority: "native-agent",
          permissionIntent: "native-escalation",
          approvalRequirement: "explicit-escalation",
          authorityReason: "explicit-escalation",
          commandApprovalPolicySnapshot: "manual",
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TerminalTargetRecoveryError);
    expect(error).toMatchObject({
      target_value: "Tests",
      compatible_terminals: [
        {
          terminal_id: created.terminal_id,
          terminal_name: "Tests",
          authority: "sandbox",
        },
      ],
    });
    expect((error as Error).message).toContain('terminal_name="Tests"');
    expect((error as Error).message).not.toContain("AgentLink T1 · Tests");
  });

  it("scopes close-all and recently closed output to one owner", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const first = registry.forOwner(t1);
    const second = registry.forOwner(t2);
    const firstTerminal = await first.executeCommand({
      owner: undefined,
      command: "one",
      cwd: "/tmp",
    });
    const secondTerminal = await second.executeCommand({
      owner: undefined,
      command: "two",
      cwd: "/tmp",
    });

    expect(first.closeTerminals({ owner: undefined })).toEqual({ closed: 1 });
    expect(second.listTerminals({ owner: undefined })).toEqual([
      expect.objectContaining({ id: secondTerminal.terminal_id }),
    ]);
    expect(first.getRecentlyClosedTerminals({ owner: undefined })).toEqual([
      expect.objectContaining({
        id: firstTerminal.terminal_id,
        name: "AgentLink",
      }),
    ]);
    expect(second.getRecentlyClosedTerminals({ owner: undefined })).toEqual([]);
  });

  it("retires a prepared terminal before assignment by its physical title", async () => {
    const base = createProvider();
    let preparedOptions: TerminalExecuteOptions | undefined;
    base.provider.prepareExecution = vi.fn(async (options, routeContext) => {
      preparedOptions = options;
      return {
        security: {
          auditId: "audit-1",
          route: "native",
          executionSurface: "vscode-compatibility",
          confinement: "native-unsandboxed",
          routeReason: "unsupported-host",
          ...routeContext,
          executionPolicy: "native-legacy-v1",
          preparedAt: 1,
        },
        execute: vi.fn(),
        dispose: vi.fn(),
      };
    });
    const registry = new TabTerminalProviderRegistry(base.provider);
    const provider = registry.forOwner(t1);
    const routeContext = {
      approvalPolicySnapshot: "on-request",
      approvalReviewerSnapshot: "user",
      executionPresetSnapshot: "native-manual",
      requiredAuthority: "native-agent",
      permissionIntent: "default",
      approvalRequirement: "policy",
      authorityReason: "approval-policy",
      commandApprovalPolicySnapshot: "manual",
    } as const;

    await provider.prepareExecution?.(
      {
        owner: undefined,
        command: "npm test",
        cwd: "/tmp",
        terminal_name: "Tests",
      },
      routeContext,
    );
    registry.retireOwner(t1);

    expect(preparedOptions?.terminal_name).toBe("AgentLink T1 · Tests");
    expect(base.provider.closeTerminals).toHaveBeenCalledWith({
      owner: {
        scopeId: "tab-1",
        displayLabel: "T1",
        generation: 1,
        authoritySessionId: "session-1",
      },
      names: ["AgentLink T1 · Tests"],
    });
  });

  it("retires only the requested generation and rejects stale providers", async () => {
    const base = createProvider();
    const registry = new TabTerminalProviderRegistry(base.provider);
    const oldProvider = registry.forOwner(t1);
    const otherProvider = registry.forOwner(t2);
    await oldProvider.executeCommand({
      owner: undefined,
      command: "old",
      cwd: "/tmp",
    });
    const other = await otherProvider.executeCommand({
      owner: undefined,
      command: "other",
      cwd: "/tmp",
    });

    expect(registry.retireOwner(t1)).toEqual({ closed: 1 });
    await expect(
      oldProvider.executeCommand({
        owner: undefined,
        command: "stale",
        cwd: "/tmp",
      }),
    ).rejects.toThrow("generation has been retired");
    expect(otherProvider.listTerminals({ owner: undefined })).toEqual([
      expect.objectContaining({ id: other.terminal_id }),
    ]);

    const nextGeneration = registry.forOwner({ ...t1, generation: 2 });
    const fresh = await nextGeneration.executeCommand({
      owner: undefined,
      command: "fresh",
      cwd: "/tmp",
    });
    expect(fresh.terminal_id).not.toBe(other.terminal_id);
    expect(base.terminals.get(fresh.terminal_id)?.name).toBe(
      "AgentLink T1 · Pool",
    );
  });

  it("does not reuse an implicit terminal across cwd or environment changes", async () => {
    const base = createProvider();
    const provider = new TabTerminalProviderRegistry(base.provider).forOwner(
      t1,
    );

    const first = await provider.executeCommand({
      owner: undefined,
      command: "one",
      cwd: "/tmp/a",
      env: { A: "1" },
    });
    const differentCwd = await provider.executeCommand({
      owner: undefined,
      command: "two",
      cwd: "/tmp/b",
      env: { A: "1" },
    });
    const differentEnv = await provider.executeCommand({
      owner: undefined,
      command: "three",
      cwd: "/tmp/a",
      env: { A: "2" },
    });

    expect(
      new Set([
        first.terminal_id,
        differentCwd.terminal_id,
        differentEnv.terminal_id,
      ]),
    ).toHaveLength(3);
  });
});
