import {
  CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
  CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY,
  isCustomTerminalSupported,
  type CustomTerminalHost,
} from "./customTerminalSupport.js";

export interface HostTerminalDisposable {
  dispose(): void;
}

export interface Phase1HostTerminalRuntime extends HostTerminalDisposable {}

export interface Phase1HostTerminalCoordinatorOptions {
  getHost(): CustomTerminalHost;
  isEnabled(): boolean;
  setContext(key: string, value: boolean): PromiseLike<unknown> | unknown;
  createRuntime(
    generation: number,
  ): PromiseLike<Phase1HostTerminalRuntime> | Phase1HostTerminalRuntime;
  subscribeEnabledChanges(listener: () => void): HostTerminalDisposable;
  onRuntimeUnavailable?(error: Error): PromiseLike<void> | void;
  log?(message: string): void;
}

export class Phase1HostTerminalCoordinator implements HostTerminalDisposable {
  private generation = 0;
  private transitionQueue = Promise.resolve();
  private enabledSubscription: HostTerminalDisposable | undefined;
  private runtime: Phase1HostTerminalRuntime | undefined;
  private started = false;
  private disposed = false;
  private acceptingRequests = false;

  constructor(private readonly options: Phase1HostTerminalCoordinatorOptions) {}

  start(): Promise<void> {
    if (this.started || this.disposed) return this.transitionQueue;
    this.started = true;
    this.enabledSubscription = this.options.subscribeEnabledChanges(() => {
      void this.refresh();
    });
    return this.refresh();
  }

  whenIdle(): Promise<void> {
    return this.transitionQueue;
  }

  refresh(): Promise<void> {
    if (this.disposed) return this.transitionQueue;
    const generation = ++this.generation;
    const host = this.options.getHost();
    const supported = isCustomTerminalSupported(host);
    this.acceptingRequests = false;

    this.transitionQueue = this.transitionQueue
      .catch((error: unknown) => {
        this.logError("Previous custom terminal transition failed", error);
      })
      .then(async () => {
        const supportPublished = await this.publishContext(
          CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY,
          supported,
        );
        const unavailablePublished = await this.publishContext(
          CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
          false,
        );
        if (!this.isCurrent(generation)) return;
        if (!supportPublished || !unavailablePublished) {
          this.disposeRuntime();
          return;
        }

        if (!supported || !this.options.isEnabled()) {
          this.disposeRuntime();
          return;
        }

        if (!this.runtime) {
          let candidate: Phase1HostTerminalRuntime;
          try {
            candidate = await this.options.createRuntime(generation);
          } catch (error) {
            const failure =
              error instanceof Error ? error : new Error(String(error));
            this.logError("Failed to create custom terminal runtime", failure);
            try {
              await this.options.onRuntimeUnavailable?.(failure);
            } catch (notificationError) {
              this.logError(
                "Failed to show custom terminal remediation",
                notificationError,
              );
            }
            return;
          }
          if (!this.isCurrent(generation)) {
            candidate.dispose();
            return;
          }
          this.runtime = candidate;
        }

        const availabilityPublished = await this.publishContext(
          CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
          true,
        );
        if (!availabilityPublished || !this.isCurrent(generation)) {
          this.acceptingRequests = false;
          this.disposeRuntime();
          await this.publishContext(
            CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
            false,
          );
          return;
        }
        this.acceptingRequests = true;
      });

    return this.transitionQueue;
  }

  get isAcceptingRequests(): boolean {
    return this.acceptingRequests && !this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.acceptingRequests = false;
    this.enabledSubscription?.dispose();
    this.enabledSubscription = undefined;
    this.disposeRuntime();
    void this.publishContext(CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY, false);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private disposeRuntime(): void {
    const runtime = this.runtime;
    this.runtime = undefined;
    runtime?.dispose();
  }

  private async publishContext(key: string, value: boolean): Promise<boolean> {
    try {
      await this.options.setContext(key, value);
      return true;
    } catch (error) {
      this.logError(`Failed to publish ${key}=${value}`, error);
      return false;
    }
  }

  private logError(message: string, error: unknown): void {
    this.options.log?.(`${message}: ${String(error)}`);
  }
}
