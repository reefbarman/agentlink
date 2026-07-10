export type FleetAdmissionCode =
  | "parent_not_found"
  | "max_depth"
  | "max_children"
  | "budget_reservation"
  | "invalid_ancestry";

export interface FleetAdmissionFailure {
  ok: false;
  code: FleetAdmissionCode;
  message: string;
  limit?: number;
}

export interface FleetAdmissionSuccess {
  ok: true;
  depth: number;
}

export type FleetAdmissionResult =
  | FleetAdmissionSuccess
  | FleetAdmissionFailure;

export interface FleetSchedulerPolicy {
  maxConcurrent: number;
  maxConcurrentPerRoot: number;
  maxDepth: number;
  maxChildrenPerParent: number;
}

export class FleetAdmissionError extends Error {
  constructor(readonly result: FleetAdmissionFailure) {
    super(result.message);
    this.name = "FleetAdmissionError";
  }
}

/** Pure admission/fairness policy shared by native and ACP fleet launches. */
export class FleetScheduler {
  constructor(readonly policy: FleetSchedulerPolicy) {}

  evaluateSpawn(args: {
    parentRequested: boolean;
    parentFound: boolean;
    parentDepth: number;
    activeChildren: number;
    ancestryValid?: boolean;
  }): FleetAdmissionResult {
    if (args.parentRequested && !args.parentFound) {
      return {
        ok: false,
        code: "parent_not_found",
        message: "Background spawn rejected: parent session not found.",
      };
    }
    if (args.ancestryValid === false) {
      return {
        ok: false,
        code: "invalid_ancestry",
        message: "Background spawn rejected: invalid or cyclic ancestry.",
      };
    }
    if (args.parentDepth >= this.policy.maxDepth) {
      return {
        ok: false,
        code: "max_depth",
        message: `Background spawn rejected: maximum fleet depth reached (${this.policy.maxDepth}).`,
        limit: this.policy.maxDepth,
      };
    }
    if (args.parentFound && args.activeChildren >= this.policy.maxChildrenPerParent) {
      return {
        ok: false,
        code: "max_children",
        message: `Background spawn rejected: per-parent child limit reached (${this.policy.maxChildrenPerParent}).`,
        limit: this.policy.maxChildrenPerParent,
      };
    }
    return { ok: true, depth: args.parentDepth + 1 };
  }

  canStart(args: { activeGlobal: number; activeForRoot: number }): boolean {
    return (
      args.activeGlobal < this.policy.maxConcurrent &&
      args.activeForRoot < this.policy.maxConcurrentPerRoot
    );
  }

  findNextRunnable<T>(
    queue: readonly T[],
    canStart: (entry: T) => boolean,
  ): number {
    return queue.findIndex(canStart);
  }
}
