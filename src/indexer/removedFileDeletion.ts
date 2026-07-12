export const QDRANT_DELETE_BATCH_SIZE = 256;

export interface RemovedFileDeleteInput {
  relPath: string;
  pointIds: string[];
}

export interface RemovedFileDeletePlan {
  relPath: string;
  pointIds: string[];
  batches: string[][];
}

export interface RemovedFileDeleteResult {
  completedRelPaths: string[];
  errors: string[];
  pointsDeleted: number;
  cancelled: boolean;
}

export function planRemovedFileDeletes(
  files: RemovedFileDeleteInput[],
  batchSize = QDRANT_DELETE_BATCH_SIZE,
): RemovedFileDeletePlan[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Delete batch size must be a positive integer");
  }

  const seen = new Set<string>();
  return files.flatMap((file) => {
    if (seen.has(file.relPath)) return [];
    seen.add(file.relPath);
    return [
      {
        relPath: file.relPath,
        pointIds: [...file.pointIds],
        batches: chunk(file.pointIds, batchSize),
      },
    ];
  });
}

export function checkpointRemovedFileCaches(options: {
  writeStructuralCache: () => void;
  writeVectorCache: () => void;
}): void {
  options.writeStructuralCache();
  options.writeVectorCache();
}

export async function executeRemovedFileDeletes(
  plans: RemovedFileDeletePlan[],
  options: {
    deleteBatch: (pointIds: string[]) => Promise<void>;
    isCancelled: () => boolean;
  },
): Promise<RemovedFileDeleteResult> {
  const completedRelPaths: string[] = [];
  const errors: string[] = [];
  let pointsDeleted = 0;

  for (const plan of plans) {
    if (options.isCancelled()) {
      return { completedRelPaths, errors, pointsDeleted, cancelled: true };
    }

    let complete = true;
    for (const batch of plan.batches) {
      if (options.isCancelled()) {
        return { completedRelPaths, errors, pointsDeleted, cancelled: true };
      }
      try {
        await options.deleteBatch(batch);
        pointsDeleted += batch.length;
      } catch (error) {
        errors.push(`Failed to delete points for ${plan.relPath}: ${error}`);
        complete = false;
        break;
      }
    }
    if (complete) completedRelPaths.push(plan.relPath);
  }

  return { completedRelPaths, errors, pointsDeleted, cancelled: false };
}

function chunk(values: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize));
  }
  return batches;
}
