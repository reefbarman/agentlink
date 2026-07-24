import type {
  ClosedTerminalSnapshot,
  PreparedTerminalExecution,
  TerminalCloseResult,
  TerminalCommandResult,
  TerminalExecuteOptions,
  TerminalExecutionOwner,
  TerminalExecutionRouteContext,
  TerminalMetadata,
  TerminalProvider,
  TerminalTargetRequest,
} from "../core/capabilities/terminal.js";

export interface TabTerminalOwner {
  tabId: string;
  tabLabel: string;
  sessionId: string;
  generation: number;
}

interface OwnedTerminal {
  ownerKey: string;
  owner: TabTerminalOwner;
  logicalName: string;
  physicalName: string;
  cwd: string;
  envKey: string;
}

function ownerKey(owner: TabTerminalOwner): string {
  return `${owner.tabId}\0${owner.generation}`;
}

function executionOwner(owner: TabTerminalOwner): TerminalExecutionOwner {
  return {
    scopeId: owner.tabId,
    displayLabel: owner.tabLabel,
    generation: owner.generation,
    authoritySessionId: owner.sessionId,
  };
}

function physicalName(owner: TabTerminalOwner, logicalName: string): string {
  return logicalName === "AgentLink"
    ? `AgentLink ${owner.tabLabel}`
    : `AgentLink ${owner.tabLabel} · ${logicalName}`;
}

function environmentKey(env?: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export class TabTerminalProviderRegistry {
  private readonly terminals = new Map<string, OwnedTerminal>();
  private readonly physicalNamesByOwner = new Map<string, Set<string>>();
  private readonly retiredOwners = new Set<string>();

  constructor(private readonly provider: TerminalProvider) {}

  forOwner(owner: TabTerminalOwner): TerminalProvider {
    const snapshot = Object.freeze({ ...owner });
    return new ScopedTabTerminalProvider(this, snapshot);
  }

  retireOwner(owner: TabTerminalOwner): TerminalCloseResult {
    const key = ownerKey(owner);
    this.retiredOwners.add(key);
    const terminalIds = [...this.terminals]
      .filter(([, terminal]) => terminal.ownerKey === key)
      .map(([terminalId]) => terminalId);
    const targets = [
      ...terminalIds,
      ...(this.physicalNamesByOwner.get(key) ?? []),
    ];
    this.physicalNamesByOwner.delete(key);
    if (targets.length === 0) return { closed: 0 };
    const result = this.provider.closeTerminals({
      owner: executionOwner(owner),
      names: [...new Set(targets)],
    });
    this.pruneTerminalRecords();
    return { closed: result.closed };
  }

  isRetired(owner: TabTerminalOwner): boolean {
    return this.retiredOwners.has(ownerKey(owner));
  }

  ownedTerminal(
    terminalId: string,
    owner: TabTerminalOwner,
  ): OwnedTerminal | undefined {
    const terminal = this.terminals.get(terminalId);
    return terminal?.ownerKey === ownerKey(owner) ? terminal : undefined;
  }

  ownedTerminals(owner: TabTerminalOwner): Array<[string, OwnedTerminal]> {
    const key = ownerKey(owner);
    return [...this.terminals].filter(
      ([, terminal]) => terminal.ownerKey === key,
    );
  }

  activeOwnedTerminals(
    owner: TabTerminalOwner,
  ): Array<[string, OwnedTerminal]> {
    const active = new Map(
      this.provider
        .listTerminals({ owner: executionOwner(owner) })
        .map((terminal) => [terminal.id, terminal]),
    );
    return this.ownedTerminals(owner).filter(([terminalId]) =>
      active.has(terminalId),
    );
  }

  pruneTerminalRecords(): void {
    const retainedIds = new Set([
      ...this.provider
        .listTerminals({ owner: undefined })
        .map((terminal) => terminal.id),
      ...this.provider
        .getRecentlyClosedTerminals({ owner: undefined, limit: 20 })
        .map((terminal) => terminal.id),
    ]);
    for (const terminalId of this.terminals.keys()) {
      if (!retainedIds.has(terminalId)) this.terminals.delete(terminalId);
    }
  }

  reservePhysicalName(owner: TabTerminalOwner, name: string): void {
    const key = ownerKey(owner);
    const names = this.physicalNamesByOwner.get(key) ?? new Set<string>();
    names.add(name);
    this.physicalNamesByOwner.set(key, names);
  }

  register(
    terminalId: string,
    owner: TabTerminalOwner,
    logicalName: string,
    resolvedPhysicalName: string,
    cwd: string,
    envKey: string,
  ): void {
    if (this.isRetired(owner)) {
      this.provider.closeTerminals({
        owner: executionOwner(owner),
        names: [terminalId],
      });
      throw new Error(
        "The owning chat tab terminal generation has been retired.",
      );
    }
    const existing = this.terminals.get(terminalId);
    const key = ownerKey(owner);
    if (existing && existing.ownerKey !== key) {
      throw new Error("Terminal ownership conflict.");
    }
    this.terminals.set(terminalId, {
      ownerKey: key,
      owner: { ...owner },
      logicalName,
      physicalName: resolvedPhysicalName,
      cwd,
      envKey,
    });
  }

  get baseProvider(): TerminalProvider {
    return this.provider;
  }
}

class ScopedTabTerminalProvider implements TerminalProvider {
  constructor(
    private readonly registry: TabTerminalProviderRegistry,
    private readonly owner: TabTerminalOwner,
  ) {}

  get log(): ((message: string) => void) | undefined {
    return this.registry.baseProvider.log;
  }

  set log(value: ((message: string) => void) | undefined) {
    this.registry.baseProvider.log = value;
  }

  async prepareExecution(
    options: TerminalExecuteOptions,
    routeContext: TerminalExecutionRouteContext,
  ): Promise<PreparedTerminalExecution> {
    this.assertActive();
    const transformed = this.transformOptions(options);
    const base = this.registry.baseProvider;
    if (!base.prepareExecution) {
      throw new Error(
        "Tab-owned terminal execution requires an approval-aware terminal provider.",
      );
    }
    const prepared = await base.prepareExecution(transformed, routeContext);
    return {
      security: prepared.security,
      execute: async () => {
        if (this.registry.isRetired(this.owner)) {
          prepared.dispose();
          this.assertActive();
        }
        return this.mapResult(await prepared.execute());
      },
      dispose: () => prepared.dispose(),
    };
  }

  async executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult> {
    this.assertActive();
    return this.mapResult(
      await this.registry.baseProvider.executeCommand(
        this.transformOptions(options),
      ),
    );
  }

  getBackgroundState(request: TerminalTargetRequest) {
    if (!this.authorizeRequest(request)) return undefined;
    return this.registry.baseProvider.getBackgroundState(
      this.targetRequest(request.terminalId),
    );
  }

  getCurrentOutput(request: TerminalTargetRequest & { force?: boolean }) {
    if (!this.authorizeRequest(request)) return undefined;
    return this.registry.baseProvider.getCurrentOutput?.({
      ...this.targetRequest(request.terminalId),
      ...(request.force === undefined ? {} : { force: request.force }),
    });
  }

  getRetainedOutput(request: TerminalTargetRequest) {
    if (!this.authorizeRequest(request)) return undefined;
    return this.registry.baseProvider.getRetainedOutput?.(
      this.targetRequest(request.terminalId),
    );
  }

  detachRetainedOutput(request: TerminalTargetRequest) {
    if (!this.authorizeRequest(request)) return undefined;
    return this.registry.baseProvider.detachRetainedOutput?.(
      this.targetRequest(request.terminalId),
    );
  }

  interruptTerminal(request: TerminalTargetRequest): boolean {
    return (
      this.authorizeRequest(request) &&
      this.registry.baseProvider.interruptTerminal(
        this.targetRequest(request.terminalId),
      )
    );
  }

  detachTerminal(request: TerminalTargetRequest): boolean {
    return (
      this.authorizeRequest(request) &&
      (this.registry.baseProvider.detachTerminal?.(
        this.targetRequest(request.terminalId),
      ) ??
        false)
    );
  }

  revealTerminal(request: TerminalTargetRequest): boolean {
    return (
      this.authorizeRequest(request) &&
      (this.registry.baseProvider.revealTerminal?.(
        this.targetRequest(request.terminalId),
      ) ??
        false)
    );
  }

  getRecentlyClosedTerminals(request: {
    owner: TerminalExecutionOwner | undefined;
    limit?: number;
  }): ClosedTerminalSnapshot[] {
    if (!this.acceptsRequestOwner(request.owner)) return [];
    if (this.registry.isRetired(this.owner)) return [];
    return this.registry.baseProvider
      .getRecentlyClosedTerminals({
        owner: executionOwner(this.owner),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      })
      .flatMap((terminal) => {
        const owned = this.registry.ownedTerminal(terminal.id, this.owner);
        return owned ? [{ ...terminal, name: owned.logicalName }] : [];
      })
      .slice(0, Math.max(0, request.limit ?? 5));
  }

  listTerminals(request: {
    owner: TerminalExecutionOwner | undefined;
  }): TerminalMetadata[] {
    if (!this.acceptsRequestOwner(request.owner)) return [];
    if (this.registry.isRetired(this.owner)) return [];
    return this.registry.baseProvider
      .listTerminals({ owner: executionOwner(this.owner) })
      .flatMap((terminal) => {
        const owned = this.registry.ownedTerminal(terminal.id, this.owner);
        return owned ? [{ ...terminal, name: owned.logicalName }] : [];
      });
  }

  closeTerminals(request: {
    owner: TerminalExecutionOwner | undefined;
    names?: string[];
  }): TerminalCloseResult {
    if (!this.acceptsRequestOwner(request.owner)) {
      return {
        closed: 0,
        ...(request.names?.length ? { not_found: [...request.names] } : {}),
      };
    }
    if (this.registry.isRetired(this.owner)) {
      return {
        closed: 0,
        ...(request.names?.length ? { not_found: [...request.names] } : {}),
      };
    }
    const owned = this.registry.activeOwnedTerminals(this.owner);
    const requested = request.names?.length ? request.names : undefined;
    const terminalIds = requested
      ? owned
          .filter(([terminalId, terminal]) =>
            requested.some(
              (target) =>
                target === terminalId || target === terminal.logicalName,
            ),
          )
          .map(([terminalId]) => terminalId)
      : owned.map(([terminalId]) => terminalId);
    const notFound = requested?.filter(
      (target) =>
        !owned.some(
          ([terminalId, terminal]) =>
            target === terminalId || target === terminal.logicalName,
        ),
    );
    const result =
      terminalIds.length > 0
        ? this.registry.baseProvider.closeTerminals({
            owner: executionOwner(this.owner),
            names: terminalIds,
          })
        : { closed: 0 };
    return {
      closed: result.closed,
      ...(notFound?.length ? { not_found: notFound } : {}),
    };
  }

  recordExecutionAudit(
    event: Parameters<NonNullable<TerminalProvider["recordExecutionAudit"]>>[0],
  ): void {
    this.registry.baseProvider.recordExecutionAudit?.(event);
  }

  private assertActive(): void {
    if (this.registry.isRetired(this.owner)) {
      throw new Error(
        "The owning chat tab terminal generation has been retired.",
      );
    }
  }

  private acceptsRequestOwner(
    requested: TerminalExecutionOwner | undefined,
  ): boolean {
    const owner = executionOwner(this.owner);
    return (
      requested === undefined ||
      (requested.scopeId === owner.scopeId &&
        requested.displayLabel === owner.displayLabel &&
        requested.generation === owner.generation &&
        requested.authoritySessionId === owner.authoritySessionId)
    );
  }

  private authorizeRequest(request: TerminalTargetRequest): boolean {
    return (
      this.acceptsRequestOwner(request.owner) &&
      !this.registry.isRetired(this.owner) &&
      this.registry.ownedTerminal(request.terminalId, this.owner) !== undefined
    );
  }

  private targetRequest(terminalId: string): TerminalTargetRequest {
    return { owner: executionOwner(this.owner), terminalId };
  }

  private transformOptions(
    options: TerminalExecuteOptions,
  ): TerminalExecuteOptions {
    this.assertActive();
    if (!this.acceptsRequestOwner(options.owner)) {
      throw new Error("Terminal execution owner does not match this chat tab.");
    }
    let terminalId = options.terminal_id;
    let splitFrom = options.split_from;
    const envKey = environmentKey(options.env);
    if (terminalId && !this.registry.ownedTerminal(terminalId, this.owner)) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    if (splitFrom) {
      const matches = this.registry
        .ownedTerminals(this.owner)
        .filter(
          ([candidateId, terminal]) =>
            candidateId === splitFrom || terminal.logicalName === splitFrom,
        );
      if (matches.length !== 1) {
        throw new Error(`Terminal split source not found: ${splitFrom}`);
      }
      splitFrom = matches[0][0];
    }

    const logicalName =
      (terminalId
        ? this.registry.ownedTerminal(terminalId, this.owner)?.logicalName
        : options.terminal_name) ?? "AgentLink";
    if (!terminalId && !options.split_from) {
      const activeMetadata = new Map(
        this.registry.baseProvider
          .listTerminals({ owner: executionOwner(this.owner) })
          .map((terminal) => [terminal.id, terminal]),
      );
      const reusable = this.registry
        .activeOwnedTerminals(this.owner)
        .find(
          ([terminalId, terminal]) =>
            activeMetadata.get(terminalId)?.busy === false &&
            terminal.logicalName === logicalName &&
            terminal.envKey === envKey &&
            terminal.cwd === options.cwd,
        );
      terminalId = reusable?.[0];
    }
    const resolvedPhysicalName = physicalName(this.owner, logicalName);
    this.registry.reservePhysicalName(this.owner, resolvedPhysicalName);
    const assign = (assignedId: string) => {
      this.registry.register(
        assignedId,
        this.owner,
        logicalName,
        resolvedPhysicalName,
        options.cwd,
        envKey,
      );
      options.onTerminalAssigned?.(assignedId);
    };

    return {
      ...options,
      owner: executionOwner(this.owner),
      ...(terminalId
        ? { terminal_id: terminalId, terminal_name: undefined }
        : { terminal_name: resolvedPhysicalName }),
      ...(splitFrom ? { split_from: splitFrom } : {}),
      onTerminalAssigned: assign,
    };
  }

  private mapResult(result: TerminalCommandResult): TerminalCommandResult {
    const owned = this.registry.ownedTerminal(result.terminal_id, this.owner);
    if (!owned) {
      throw new Error("Terminal execution returned an unowned terminal.");
    }
    return { ...result, terminal_name: owned.logicalName };
  }
}
