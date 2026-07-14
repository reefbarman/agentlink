export type CacheCheckpointKind = "vector" | "structural";

export interface CacheCheckpointCoordinatorOptions {
  writeVector(): void;
  writeStructural(): void;
}

export class CacheCheckpointCoordinator {
  private vectorDirty = false;
  private structuralDirty = false;

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

  flushVector(): boolean {
    if (!this.vectorDirty) return false;
    this.options.writeVector();
    this.vectorDirty = false;
    return true;
  }

  flushStructural(): boolean {
    if (!this.structuralDirty) return false;
    this.options.writeStructural();
    this.structuralDirty = false;
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

  get pending(): Readonly<Record<CacheCheckpointKind, boolean>> {
    return {
      vector: this.vectorDirty,
      structural: this.structuralDirty,
    };
  }
}
