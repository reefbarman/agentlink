import type {
  SkillCatalogFallbackIdentity,
  SkillCatalogFallbackProvider,
  SkillCatalogFallbackPublication,
} from "../../agent/skillCatalogFallbackProvider.js";

import { SkillCatalogRetrievalService } from "../../core/catalog/SkillCatalogRetrievalService.js";

export class RetrievalSkillCatalogFallbackProvider implements SkillCatalogFallbackProvider {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly identities = new Map<string, SkillCatalogFallbackIdentity>();
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly service: SkillCatalogRetrievalService,
    private readonly publisherScope: string,
  ) {}

  update(publication: SkillCatalogFallbackPublication): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const scoped = this.scope(publication);
    this.identities.set(this.key(scoped), scoped);
    return this.enqueue(scoped, async () => {
      if (publication.entries.length === 0) {
        const outcome = await this.service.clearFallback(scoped);
        if (outcome !== "unavailable") {
          this.identities.delete(this.key(scoped));
        }
        return;
      }
      await this.service.publishFallback({ ...publication, ...scoped });
    });
  }

  remove(identity: SkillCatalogFallbackIdentity): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const scoped = this.scope(identity);
    this.identities.set(this.key(scoped), scoped);
    return this.enqueue(scoped, async () => {
      const outcome = await this.service.clearFallback(scoped);
      if (outcome !== "unavailable") {
        this.identities.delete(this.key(scoped));
      }
    });
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      await Promise.allSettled(
        [...this.identities.values()].map((identity) =>
          this.enqueue(identity, async () => {
            await this.service.clearFallback(identity);
          }),
        ),
      );
      this.identities.clear();
      await Promise.allSettled(this.queues.values());
    })();
    return this.disposePromise;
  }

  private scope(
    identity: SkillCatalogFallbackIdentity,
  ): SkillCatalogFallbackIdentity {
    return {
      publisherId: `${this.publisherScope}:${identity.publisherId}`,
      projectId: identity.projectId,
    };
  }

  private key(identity: SkillCatalogFallbackIdentity): string {
    return `${identity.publisherId}\u0000${identity.projectId}`;
  }

  private enqueue(
    identity: SkillCatalogFallbackIdentity,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = this.key(identity);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(key, next);
    const cleanup = () => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
