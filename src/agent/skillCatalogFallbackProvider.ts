export interface SkillCatalogFallbackPublicationEntry {
  id: string;
  name: string;
  description: string;
  revision: string;
  invocation?: "auto" | "manual";
  recommendations?: string[];
}

export interface SkillCatalogFallbackPublication {
  publisherId: string;
  projectId: string;
  catalogRevision: string;
  observedAt: string;
  entries: SkillCatalogFallbackPublicationEntry[];
}

export interface SkillCatalogFallbackIdentity {
  publisherId: string;
  projectId: string;
}

/** Best-effort projection lifecycle. Canonical session skills remain authoritative. */
export interface SkillCatalogFallbackProvider {
  update(publication: SkillCatalogFallbackPublication): Promise<void>;
  remove(identity: SkillCatalogFallbackIdentity): Promise<void>;
}
