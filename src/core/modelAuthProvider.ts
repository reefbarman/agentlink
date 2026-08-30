import type { CoreModelAuthLease } from "@agentlink/protocol/model-auth";

export interface CoreModelAuthProvider {
  requestLease(request: {
    ownerId: string;
    ownerGenerationId: string;
    modelScopes: string[];
    helperGenerationId: string;
    now: number;
  }): Promise<CoreModelAuthLease | null>;
  revokeLease(leaseId: string, reason: string): Promise<void>;
}
