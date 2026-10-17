import {
  expectedReleaseAsset,
  parseReleaseVersion,
} from "./releaseSelection.js";

import type { AssistantUpdateDiscovery } from "../shared/assistantUpdates.js";
import { GithubReleaseClient } from "./githubReleaseClient.js";
import type { ReleaseUpdateIdentity } from "./releaseUpdateTypes.js";
import { ReleaseUpdateService } from "./ReleaseUpdateService.js";
import { ReleaseUpdateStore } from "./releaseUpdateStore.js";

export interface AssistantReleaseUpdateServiceOptions {
  version: string;
  target: string;
  storageDirectory: string;
  automaticChecks?: boolean;
  includePreviews?: boolean;
  now?: () => number;
  client?: Pick<GithubReleaseClient, "discover">;
}

/** Pull-only Assistant discovery using the shared release cache and refresh lease. */
export class AssistantReleaseUpdateService {
  private readonly service: ReleaseUpdateService;
  private readonly store: ReleaseUpdateStore;
  private readonly identity: ReleaseUpdateIdentity;
  private automaticChecks: boolean;
  private includePreviews: boolean;
  private started: Promise<void> | undefined;

  constructor(private readonly options: AssistantReleaseUpdateServiceOptions) {
    this.automaticChecks = options.automaticChecks ?? true;
    this.includePreviews = options.includePreviews ?? false;
    this.identity = {
      product: "assistant",
      version: options.version,
      target: options.target,
      development: false,
      includePreviews: this.includePreviews,
    };
    this.store = new ReleaseUpdateStore(
      options.storageDirectory,
      this.identity,
    );
    this.service = new ReleaseUpdateService({
      identity: this.identity,
      storageDirectory: options.storageDirectory,
      automaticChecks: this.automaticChecks,
      store: this.store,
      now: options.now,
      client: options.client,
    });
  }

  start(): Promise<void> {
    return (this.started ??= this.initialise());
  }

  private async initialise(): Promise<void> {
    const preferences = await this.store.readPreferences();
    this.automaticChecks =
      this.options.automaticChecks ?? preferences?.automaticChecks ?? true;
    this.includePreviews =
      this.options.includePreviews ?? preferences?.includePreviews ?? false;
    this.identity.includePreviews = this.includePreviews;
    await this.service.setAutomaticChecks(this.automaticChecks, false);
    await this.service.start();
  }

  snapshot(): AssistantUpdateDiscovery {
    const state = this.service.snapshot();
    return {
      status:
        !parseReleaseVersion(this.identity.version) ||
        !expectedReleaseAsset(
          "assistant",
          this.identity.version,
          this.identity.target,
        )
          ? "unsupported"
          : state.status === "metadata_unavailable"
            ? "unavailable"
            : state.status,
      automaticChecks: this.automaticChecks,
      includePreviews: this.includePreviews,
      checkedAt: state.checkedAt,
      lastAttemptAt: state.lastAttemptAt,
      retryAt: state.retryAt,
      stale: state.stale,
      ...(state.error ? { error: state.error } : {}),
      releases: (state.history ?? []).map((release) => ({
        version: release.version,
        tag: release.tag,
        channel: release.channel,
        releaseUrl: release.releaseUrl,
        notes: release.notes ?? "",
      })),
    };
  }

  async check(manual = true): Promise<AssistantUpdateDiscovery> {
    await this.start();
    await this.service.check(manual);
    return this.snapshot();
  }

  async setPreferences(preferences: {
    automaticChecks: boolean;
    includePreviews: boolean;
  }): Promise<void> {
    await this.start();
    await this.store.writePreferences(preferences);
    this.automaticChecks = preferences.automaticChecks;
    this.includePreviews = preferences.includePreviews;
    this.identity.includePreviews = preferences.includePreviews;
    await this.service.setAutomaticChecks(preferences.automaticChecks, false);
    await this.service.reproject();
    if (preferences.automaticChecks) this.service.checkDue();
  }

  dispose(): void {
    this.service.dispose();
  }
}
