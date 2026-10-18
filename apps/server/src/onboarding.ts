import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * First-run setup progress: which setup steps the owner finished or put off,
 * and whether they said the backup password is saved somewhere else. Kept
 * in `<dataRoot>/settings/onboarding.json`.
 *
 * It records the owner's claims and choices only. Facts (is ChatGPT signed
 * in, did the last backup work) come from their own stores every time, so
 * a finished checklist never hides a later failure. It holds no tokens,
 * keys, sign-in addresses, persona or provider settings.
 *
 * The guided installer writes this file with `freshInstall: true`, so a new
 * installation opens setup. A server without the file (an existing or
 * hand-made installation) gets a non-blocking "Review setup" entry instead.
 */

export const ONBOARDING_STEPS = [
  "model",
  "preferences",
  "connections",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingRecord {
  readonly schemaVersion: 1;
  /** Bumped on every change; a stale tab's change is refused. */
  readonly revision: number;
  /** Written by the guided installer: open setup on first sign-in. */
  readonly freshInstall: boolean;
  readonly steps: Partial<
    Record<
      OnboardingStep,
      { readonly state: "done" | "deferred"; readonly at: number }
    >
  >;
  /** The owner said the backup password is kept off this machine. */
  readonly backupPasswordSavedAt?: number;
  readonly completedAt?: number;
  readonly dismissedAt?: number;
}

export interface OnboardingPatch {
  readonly step?: {
    readonly id: OnboardingStep;
    readonly state: "done" | "deferred";
  };
  readonly backupPasswordSaved?: true;
  readonly complete?: true;
  readonly dismiss?: true;
}

export class OnboardingInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface OnboardingStore {
  /** Undefined when there is no record (setup never offered automatically). */
  get(): OnboardingRecord | undefined;
  update(
    patch: OnboardingPatch,
    expectedRevision: number,
    now: number,
  ): Promise<OnboardingRecord>;
}

const MAX_FILE_BYTES = 16 * 1024;

export function emptyOnboarding(freshInstall: boolean): OnboardingRecord {
  return { schemaVersion: 1, revision: 0, freshInstall, steps: {} };
}

/** Validate an untrusted change; throws `OnboardingInputError`. */
export function parseOnboardingPatch(body: Record<string, unknown>): {
  readonly patch: OnboardingPatch;
  readonly expectedRevision: number;
} {
  const allowed = [
    "expectedRevision",
    "step",
    "backupPasswordSaved",
    "complete",
    "dismiss",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new OnboardingInputError("onboarding_request_invalid");
  }
  const revision = body.expectedRevision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new OnboardingInputError("onboarding_revision_required");
  }
  let step: OnboardingPatch["step"];
  if (body.step !== undefined) {
    const value = body.step as Record<string, unknown> | null;
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).some((key) => key !== "id" && key !== "state") ||
      !ONBOARDING_STEPS.includes(value.id as OnboardingStep) ||
      (value.state !== "done" && value.state !== "deferred")
    ) {
      throw new OnboardingInputError("onboarding_step_invalid");
    }
    step = { id: value.id as OnboardingStep, state: value.state };
  }
  for (const flag of ["backupPasswordSaved", "complete", "dismiss"] as const) {
    if (body[flag] !== undefined && body[flag] !== true) {
      throw new OnboardingInputError("onboarding_request_invalid");
    }
  }
  const patch: OnboardingPatch = {
    ...(step ? { step } : {}),
    ...(body.backupPasswordSaved === true ? { backupPasswordSaved: true } : {}),
    ...(body.complete === true ? { complete: true } : {}),
    ...(body.dismiss === true ? { dismiss: true } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new OnboardingInputError("onboarding_request_invalid");
  }
  return { patch, expectedRevision: revision };
}

export function applyOnboardingPatch(
  record: OnboardingRecord,
  patch: OnboardingPatch,
  now: number,
): OnboardingRecord {
  return {
    ...record,
    revision: record.revision + 1,
    steps: patch.step
      ? {
          ...record.steps,
          [patch.step.id]: { state: patch.step.state, at: now },
        }
      : record.steps,
    ...(patch.backupPasswordSaved ? { backupPasswordSavedAt: now } : {}),
    ...(patch.complete ? { completedAt: now } : {}),
    ...(patch.dismiss ? { dismissedAt: now } : {}),
  };
}

function parseRecord(raw: string, file: string): OnboardingRecord {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const invalid = () =>
    new Error(`${file} is not an onboarding file this server reads`);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.freshInstall !== "boolean"
  ) {
    throw invalid();
  }
  const steps: Record<string, { state: "done" | "deferred"; at: number }> = {};
  const rawSteps = (value.steps ?? {}) as Record<string, unknown>;
  if (typeof rawSteps !== "object" || Array.isArray(rawSteps)) throw invalid();
  for (const id of ONBOARDING_STEPS) {
    const step = rawSteps[id] as Record<string, unknown> | undefined;
    if (step === undefined) continue;
    if (
      !step ||
      (step.state !== "done" && step.state !== "deferred") ||
      typeof step.at !== "number"
    ) {
      throw invalid();
    }
    steps[id] = { state: step.state, at: step.at };
  }
  const time = (key: string) =>
    typeof value[key] === "number" ? { [key]: value[key] as number } : {};
  return {
    schemaVersion: 1,
    revision: value.revision,
    freshInstall: value.freshInstall,
    steps,
    ...time("backupPasswordSavedAt"),
    ...time("completedAt"),
    ...time("dismissedAt"),
  };
}

/**
 * Open the setup record. A missing file is fine (no record); an unreadable
 * or unrecognised one stops the server rather than silently restarting
 * setup over the owner's progress.
 */
export async function openOnboardingStore(options: {
  readonly file: string;
}): Promise<OnboardingStore> {
  let current: OnboardingRecord | undefined;
  try {
    const stat = await fs.lstat(options.file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `${options.file} is not an onboarding file this server reads`,
      );
    }
    current = parseRecord(
      await fs.readFile(options.file, "utf8"),
      options.file,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let writes: Promise<unknown> = Promise.resolve();
  return {
    get: () => current,
    update(patch, expectedRevision, now) {
      const write = writes.then(async () => {
        const base = current ?? emptyOnboarding(false);
        if (base.revision !== expectedRevision) {
          throw new OnboardingInputError("onboarding_changed");
        }
        const next = applyOnboardingPatch(base, patch, now);
        await fs.mkdir(path.dirname(options.file), {
          recursive: true,
          mode: 0o700,
        });
        await writeFileAtomic(
          options.file,
          `${JSON.stringify(next, null, 2)}\n`,
        );
        current = next;
        return next;
      });
      writes = write.catch(() => undefined);
      return write;
    },
  };
}

/**
 * An optional feature's state, read from the configuration this server
 * started with. Turning one on or off is a local installer command on the
 * machine (`install.sh enable|disable`); the browser only shows the state
 * and the command, it cannot change it.
 */
export type OnboardingFeatureState = "on" | "off" | "needs-runners";

/** What the setup summary shows, read from the authoritative stores. */
export interface OnboardingFacts {
  readonly model: {
    /** Whether this server has a ChatGPT (Codex) provider at all. */
    readonly codexAvailable: boolean;
    readonly codexSignedIn: boolean;
    /** Other configured providers (operator-managed, not set up here). */
    readonly otherProviders: number;
    /** Whether an OpenAI API key may be added in setup. */
    readonly openAiKeyAvailable?: boolean;
    /** Saved, not verified: nothing is sent to OpenAI until a chat. */
    readonly openAiKeySaved?: boolean;
  };
  readonly backup: {
    readonly configured: boolean;
    readonly lastSuccessAt?: number;
    readonly failing?: boolean;
    readonly reachable?: boolean;
  };
  /** "Edit task workspaces" (`editor`) and "Research with a browser" (`browser`). */
  readonly features?: {
    readonly editor: OnboardingFeatureState;
    readonly browser: OnboardingFeatureState;
  };
}

/** A feature is on when configured; otherwise it needs session runners first. */
export function onboardingFeatures(config: {
  readonly runners?: unknown;
  readonly editor?: unknown;
  readonly browser?: unknown;
}): NonNullable<OnboardingFacts["features"]> {
  const state = (on: boolean): OnboardingFeatureState =>
    on ? "on" : config.runners === undefined ? "needs-runners" : "off";
  return {
    editor: state(config.editor !== undefined),
    browser: state(config.browser !== undefined),
  };
}

export type OnboardingStatus = "setup-incomplete" | "backup-degraded" | "ready";

/**
 * The overall state. Model access comes first: without it chats cannot
 * work. A backup problem after that is "degraded", whatever the checklist
 * says.
 */
export function onboardingStatus(
  record: OnboardingRecord | undefined,
  facts: OnboardingFacts,
): OnboardingStatus {
  const modelReady =
    facts.model.codexSignedIn ||
    facts.model.otherProviders > 0 ||
    facts.model.openAiKeySaved === true;
  if (!modelReady) return "setup-incomplete";
  if (
    facts.backup.configured &&
    (facts.backup.failing || facts.backup.lastSuccessAt === undefined)
  ) {
    return "backup-degraded";
  }
  if (!record?.completedAt) return "setup-incomplete";
  return "ready";
}

/** Open setup automatically only for a fresh install not yet finished or dismissed. */
export function shouldOpenSetup(record: OnboardingRecord | undefined): boolean {
  return Boolean(
    record?.freshInstall && !record.completedAt && !record.dismissedAt,
  );
}
