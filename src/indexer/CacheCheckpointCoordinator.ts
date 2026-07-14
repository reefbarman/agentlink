export type CacheCheckpointKind = "vector" | "structural";

export interface CacheCheckpointCoordinatorOptions {
  writeVector(): void;
  writeStructural(): void;
  schedule?(run: () => void): () => void;
}

export class CacheCheckpointCoordinator {
  private vectorDirty = false;
  private structuralDirty = false;
  private cancelScheduledFlush: (() => void) | null = null;
  private scheduledError: unknown;
  private hasScheduledError = false;

  constructor(private readonly options: CacheCheckpointCoordinatorOptions) {}

  markVectorDirty(): void {
    this.vectorDirty = true;
  }

  markStructuralDirty(): void {
    this.structuralDirty = true;
  }

  checkpointVector(): void {
    this.markVectorDirty();
    this.flushVector();
  }

  checkpointStructural(): void {
    this.markStructuralDirty();
    this.flushStructural();
  }

  checkpointBoth(order: readonly CacheCheckpointKind[]): void {
    this.markVectorDirty();
    this.markStructuralDirty();
    this.flush(order);
  }

  scheduleVector(): void {
    this.markVectorDirty();
    this.scheduleFlush();
  }

  scheduleStructural(): void {
    this.markStructuralDirty();
    this.scheduleFlush();
  }

  flushVector(): boolean {
    if (!this.vectorDirty) return false;
    this.options.writeVector();
    this.vectorDirty = false;
    this.cancelScheduleIfClean();
    return true;
  }

  flushStructural(): boolean {
    if (!this.structuralDirty) return false;
    this.options.writeStructural();
    this.structuralDirty = false;
    this.cancelScheduleIfClean();
    return true;
  }

  flush(
    order: readonly CacheCheckpointKind[] = ["vector", "structural"],
  ): void {
    for (const kind of order) {
      if (kind === "vector") this.flushVector();
      else this.flushStructural();
    }
  }

  drain(
    order: readonly CacheCheckpointKind[] = ["vector", "structural"],
  ): void {
    this.cancelScheduled();
    this.throwScheduledError();
    this.flush(order);
  }

  cancelScheduled(): void {
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = null;
  }

  get pending(): Readonly<Record<CacheCheckpointKind, boolean>> {
    return {
      vector: this.vectorDirty,
      structural: this.structuralDirty,
    };
  }

  private scheduleFlush(): void {
    if (this.cancelScheduledFlush) return;
    if (!this.options.schedule) {
      this.flush();
      return;
    }
    let invoked = false;
    const cancel = this.options.schedule(() => {
      invoked = true;
      this.cancelScheduledFlush = null;
      try {
        this.flush();
      } catch (error) {
        this.scheduledError = error;
        this.hasScheduledError = true;
      }
    });
    if (!invoked) this.cancelScheduledFlush = cancel;
  }

  private cancelScheduleIfClean(): void {
    if (this.vectorDirty || this.structuralDirty) return;
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = null;
  }

  private throwScheduledError(): void {
    if (!this.hasScheduledError) return;
    const error = this.scheduledError;
    this.scheduledError = undefined;
    this.hasScheduledError = false;
    throw error;
  }
}
