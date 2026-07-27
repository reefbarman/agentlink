export interface BoundedReadAheadPipelineOptions<TInput, TBatch> {
  inputs: readonly TInput[];
  batchSize: number;
  isCancelled: () => boolean;
  readBatch(
    inputs: readonly TInput[],
    batchStart: number,
    batchNumber: number,
  ): Promise<TBatch>;
  processBatch(
    batch: TBatch,
    batchStart: number,
    batchNumber: number,
    totalBatches: number,
  ): Promise<boolean>;
  releaseBatch(batch: TBatch): void;
}

interface PendingBatch<TBatch> {
  batchStart: number;
  batchNumber: number;
  outcome: Promise<{ batch: TBatch } | { error: unknown }>;
}

export async function runBoundedReadAheadPipeline<TInput, TBatch>(
  options: BoundedReadAheadPipelineOptions<TInput, TBatch>,
): Promise<void> {
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new Error("Read-ahead batch size must be a positive integer");
  }

  const totalBatches = Math.ceil(options.inputs.length / options.batchSize);
  let nextBatchNumber = 0;

  const startNextBatch = (): PendingBatch<TBatch> | null => {
    if (options.isCancelled() || nextBatchNumber >= totalBatches) return null;
    const batchNumber = nextBatchNumber++;
    const batchStart = batchNumber * options.batchSize;
    const inputs = options.inputs.slice(
      batchStart,
      batchStart + options.batchSize,
    );
    return {
      batchStart,
      batchNumber,
      outcome: options.readBatch(inputs, batchStart, batchNumber).then(
        (batch) => ({ batch }),
        (error: unknown) => ({ error }),
      ),
    };
  };

  const releasePendingBatch = async (
    pending: PendingBatch<TBatch> | null,
  ): Promise<void> => {
    if (!pending) return;
    const outcome = await pending.outcome;
    if ("batch" in outcome) options.releaseBatch(outcome.batch);
  };

  let pending = startNextBatch();
  while (pending) {
    const outcome = await pending.outcome;
    if ("error" in outcome) throw outcome.error;
    const { batch } = outcome;
    if (options.isCancelled()) {
      options.releaseBatch(batch);
      return;
    }

    const prefetched = startNextBatch();
    try {
      const shouldContinue = await options.processBatch(
        batch,
        pending.batchStart,
        pending.batchNumber,
        totalBatches,
      );
      if (!shouldContinue || options.isCancelled()) {
        await releasePendingBatch(prefetched);
        return;
      }
    } catch (error) {
      await releasePendingBatch(prefetched);
      throw error;
    } finally {
      options.releaseBatch(batch);
    }
    pending = prefetched;
  }
}
